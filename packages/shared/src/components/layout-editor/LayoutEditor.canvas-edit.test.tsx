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

// The editor with #2583 multi-select, #2603 Alt+arrow and #2602 Table view
// wired in: what the person sees after each gesture (the draft is optimistic).
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function field(name: string, label: string): CMSField {
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
    dependency_config: null
  }
}

const FIELDS: Record<string, CMSField> = {
  title: field('title', 'Title'),
  amount: field('amount', 'Amount'),
  notes: field('notes', 'Notes')
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

type Cmd = { _method?: string; _path: string; _body?: Record<string, unknown> }

function project(assignments: Array<Record<string, unknown>>): CMSField[] {
  return assignments
    .filter((a) => !String(a.field).startsWith('__'))
    .map((a) => ({
      ...FIELDS[String(a.field)],
      group_key: (a.group_key as string | null) ?? null,
      sort: Number(a.sort),
      layout_assigned: true
    }))
}

function makeClient() {
  let stored = makeBundle()
  let rev = 0
  return {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      const p = cmd._path
      if (p === '/collection-layouts/7/bundle') return stored
      if (p === '/collection-layouts/7/ops') {
        stored = { ...applyLayoutOps(stored, cmd._body?.ops as LayoutOp[]), rev: `r${++rev}` }
        return stored
      }
      if (p === '/field-config/orders') return { data: project(stored.placements as never) }
      if (p === '/field-config/orders/project')
        return { data: project((cmd._body?.assignments ?? []) as never) }
      if (p === '/collections/orders')
        return { data: { display_name: 'Orders', fields: Object.values(FIELDS) } }
      if ((cmd._method ?? 'GET').toUpperCase() !== 'GET') return { data: null }
      return { data: [] }
    })
  }
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

async function settle(until: () => boolean) {
  for (let i = 0; i < 100 && !until(); i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
}

const canvasFields = () =>
  [...document.querySelectorAll('[data-editor-canvas] [data-field]')].map((el) =>
    el.getAttribute('data-field')
  )
const node = (key: string) =>
  document.querySelector(`[data-design-target="${key}"]`) as HTMLElement | null

async function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={makeClient() as never}>
          <LayoutEditor collection='orders' layoutId={7} onBack={() => {}} mode='page' />
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  await settle(() => canvasFields().length >= 3)
}

const altKey = (key: string) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, bubbles: true }))
  })

describe('LayoutEditor canvas editing', () => {
  it('Shift-click selects several fields and the inspector shows the bulk panel', async () => {
    await mount()
    act(() => node('field:title:main')?.click())
    act(() => {
      node('field:notes:extra')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, shiftKey: true })
      )
    })
    await settle(() => !!document.querySelector('[data-bulk-inspector]'))
    expect(node('field:title:main')?.getAttribute('data-selected')).toBe('true')
    expect(node('field:notes:extra')?.getAttribute('data-selected')).toBe('true')
    expect(document.querySelector('[data-bulk-inspector] h2')?.textContent).toBe('2 items selected')
    // A plain click goes back to one field and its own inspector.
    act(() => node('field:amount:main')?.click())
    await settle(() => !document.querySelector('[data-bulk-inspector]'))
    expect(node('field:title:main')?.getAttribute('data-selected')).toBe(null)
  })

  it('Alt+arrow moves the selected field; the selection follows it across sections', async () => {
    await mount()
    act(() => node('field:title:main')?.click())
    altKey('ArrowDown')
    await settle(() => canvasFields()[0] === 'amount')
    expect(canvasFields()).toEqual(['amount', 'title', 'notes'])
    altKey('ArrowRight')
    await settle(() => !!node('field:title:extra'))
    expect(canvasFields()).toEqual(['amount', 'title', 'notes'])
    expect(node('field:title:extra')?.getAttribute('data-selected')).toBe('true')
    altKey('ArrowDown')
    await settle(() => canvasFields()[2] === 'title')
    expect(canvasFields()).toEqual(['amount', 'notes', 'title'])
  })

  it('Table view lists every field; Canvas brings the form back', async () => {
    await mount()
    act(() => (document.querySelector('[data-editor-view="table"]') as HTMLElement).click())
    await settle(() => !!document.querySelector('[data-placements-table]'))
    expect(
      [...document.querySelectorAll('[data-table-row]')].map((r) =>
        r.getAttribute('data-table-row')
      )
    ).toEqual(['field:title:main', 'field:amount:main', 'field:notes:extra'])
    expect(document.querySelector('[data-auto-arrange="form"]')).not.toBeNull()
    act(() => (document.querySelector('[data-editor-view="canvas"]') as HTMLElement).click())
    await settle(() => canvasFields().length === 3)
  })
})
