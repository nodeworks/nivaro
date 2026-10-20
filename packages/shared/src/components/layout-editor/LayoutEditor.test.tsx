// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import {
  applyLayoutOps,
  type LayoutBundle,
  type LayoutOp,
  newGroup,
  newPlacement,
  ungroupedGroup
} from '../../lib/layout-ops'
import type { CMSField } from '../item-edit/types'
import { LayoutEditor } from './LayoutEditor'

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
    group_key: null,
    options: null,
    computed_formula: null,
    computed_type: null,
    note: null,
    placeholder: null,
    repeater_schema: null,
    dependency_config: null,
    ...over
  }
}

const FIELDS: Record<string, CMSField> = {
  title: field('title', 'Title'),
  amount: field('amount', 'Amount', { type: 'decimal' }),
  notes: field('notes', 'Notes', { type: 'text' }),
  vendor: field('vendor', 'Vendor name')
}

function makeBundle(): LayoutBundle {
  return {
    layout: { id: 7, collection: 'orders', name: 'Order form', layout_type: 'grouped' },
    groups: [
      { ...newGroup('main', 'Main', 'section', null), id: 1, sort: 0 },
      { ...newGroup('extra', 'Extra', 'section', null), id: 2, sort: 1 },
      ungroupedGroup(2)
    ],
    placements: [
      { ...newPlacement('title', 'main'), id: 10, sort: 0 },
      { ...newPlacement('amount', 'main'), id: 11, sort: 1 },
      { ...newPlacement('notes', 'extra'), id: 12, sort: 0 }
    ],
    rev: 'r0'
  }
}

const OVERVIEW = {
  rows: [
    {
      layout_id: 7,
      name: 'Order form',
      layout_type: 'grouped',
      slug: null,
      section: 'forms',
      reason: { kind: 'default' },
      is_default: true,
      new_menu: null,
      shape: { groups: 2, steps_or_tabs: 0, fields: 3 },
      references: [],
      warnings: []
    },
    {
      layout_id: 8,
      name: 'Order summary',
      layout_type: 'summary',
      slug: null,
      section: 'other_views',
      reason: { kind: 'type_use', type_use: 'Read mode' },
      is_default: false,
      new_menu: null,
      shape: { groups: 1, steps_or_tabs: 0, fields: 2 },
      references: [],
      warnings: []
    }
  ],
  warning: null
}

type Cmd = { _method?: string; _path: string; _body?: Record<string, unknown> }

// The server's POST /field-config/:col/project, reduced to these fixtures.
function project(assignments: Array<Record<string, unknown>>): CMSField[] {
  const placed = assignments.filter((a) => !String(a.field).startsWith('__'))
  const rows = placed.map((a) => ({
    ...FIELDS[String(a.field)],
    group_key: (a.group_key as string | null) ?? null,
    sort: Number(a.sort),
    layout_assigned: true
  }))
  const names = new Set(placed.map((a) => a.field))
  for (const f of Object.values(FIELDS))
    if (!names.has(f.field)) rows.push({ ...f, group_key: null, layout_assigned: false })
  return rows
}

function makeClient() {
  const calls: Cmd[] = []
  let stored = makeBundle()
  let rev = 0
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      const p = cmd._path
      const method = (cmd._method ?? 'GET').toUpperCase()
      if (p === '/collection-layouts/7/bundle') return stored
      if (p === '/collection-layouts/7/ops') {
        stored = { ...applyLayoutOps(stored, cmd._body?.ops as LayoutOp[]), rev: `r${++rev}` }
        return stored
      }
      if (p === '/collection-layouts/overview') return { data: OVERVIEW }
      if (p === '/field-config/orders') return { data: project(stored.placements as never) }
      if (p === '/field-config/orders/project')
        return { data: project((cmd._body?.assignments ?? []) as never) }
      if (p === '/collections/orders') return { data: { display_name: 'Orders' } }
      if (method !== 'GET') return { data: null }
      return { data: [] }
    })
  }
  return { client, calls }
}

// jsdom lacks the layout observers the record form measures with.
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

async function settle(until: () => boolean) {
  for (let i = 0; i < 100 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

const canvasFields = () => host.querySelectorAll('[data-editor-canvas] [data-field]')
const opsCalls = (calls: Cmd[]) =>
  calls
    .filter((c) => c._path === '/collection-layouts/7/ops')
    .map((c) => c._body?.ops as LayoutOp[])

async function mount() {
  const { client, calls } = makeClient()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <LayoutEditor collection='orders' layoutId={7} onBack={() => {}} mode='page' />
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  await settle(() => canvasFields().length >= 3)
  return { calls }
}

function click(el: Element | null) {
  if (!el) throw new Error('nothing to click')
  act(() => {
    ;(el as HTMLElement).click()
  })
}

describe('LayoutEditor', () => {
  it('opens a grouped layout on the ItemEditForm canvas', async () => {
    await mount()
    const canvas = host.querySelector('[data-editor-canvas]')
    expect(canvas?.getAttribute('data-renderer')).toBe('item-edit-form')
    expect(canvas?.querySelector('[data-design-canvas]')).not.toBeNull()
    expect([...canvasFields()].map((el) => el.getAttribute('data-field'))).toEqual([
      'title',
      'amount',
      'notes'
    ])
    const bar = host.querySelector('[data-editor-topbar]')
    expect(bar?.textContent).toContain('Order form')
    expect(bar?.textContent).toContain('default')
    expect(bar?.textContent).toContain('anything else')
    // The rail lists the collection's layouts with their purposes.
    const rail = host.querySelector('[data-editor-rail]')
    expect(rail?.textContent).toContain('Order summary')
    expect(rail?.textContent).toContain('Read mode')
  })

  it('selecting a field opens its inspector', async () => {
    await mount()
    click(host.querySelector('[data-design-target="field:title:main"]'))
    await settle(() => !!host.querySelector('[data-editor-inspector] h3'))
    const insp = host.querySelector('[data-editor-inspector]')
    expect(insp?.textContent).toContain('Title')
    expect(insp?.textContent).toContain('Main')
    expect(
      host.querySelector('[data-design-target="field:title:main"]')?.getAttribute('data-selected')
    ).toBe('true')
  })

  it('add panel marks placed fields and adds after selection (emits one place op)', async () => {
    const { calls } = await mount()
    click(host.querySelector('[data-design-target="field:title:main"]'))
    click(host.querySelector('[data-editor-tab="add"]'))
    await settle(() => !!host.querySelector('[data-add-field="vendor"]'))
    const row = (f: string) => host.querySelector(`[data-add-field="${f}"]`)
    expect(row('title')?.getAttribute('data-on-form')).toBe('true')
    expect(row('vendor')?.getAttribute('data-on-form')).toBeNull()
    expect(row('vendor')?.textContent).toContain('Vendor name')
    click(row('vendor'))
    await settle(() => opsCalls(calls).length > 0)
    expect(opsCalls(calls)).toEqual([
      [{ op: 'place', field: 'vendor', group_key: 'main', index: 1 }]
    ])
    await settle(() => row('vendor')?.getAttribute('data-on-form') === 'true')
    expect(row('vendor')?.getAttribute('data-on-form')).toBe('true')
  })

  it('undo button reverses the last batch', async () => {
    const { calls } = await mount()
    click(host.querySelector('[data-editor-tab="add"]'))
    await settle(() => !!host.querySelector('[data-add-field="vendor"]'))
    click(host.querySelector('[data-add-field="vendor"]'))
    await settle(() => opsCalls(calls).length === 1)
    const undo = host.querySelector('[aria-label="Undo"]') as HTMLButtonElement
    await settle(() => !undo.disabled)
    click(undo)
    await settle(() => opsCalls(calls).length === 2)
    expect(opsCalls(calls)[1]).toEqual([
      { op: 'remove', at: { field: 'vendor', group_key: 'main' } }
    ])
    await settle(
      () => host.querySelector('[data-add-field="vendor"]')?.getAttribute('data-on-form') == null
    )
    expect(host.querySelector('[data-add-field="vendor"]')?.getAttribute('data-on-form')).toBeNull()
  })
})
