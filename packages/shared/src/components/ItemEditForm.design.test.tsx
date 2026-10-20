// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../context'
import { ItemEditForm } from './ItemEditForm'
import type { ActiveLayoutData, CMSField, FieldGroup } from './item-edit/types'
import type { DesignTarget, LayoutDesign } from './layout-editor/design-context'

// Design mode (layout editor canvas, spec §7.3): the record form renders a
// draft layout handed in by the editor, wraps every placement and group in a
// selectable DesignNode, and never writes — no saves, locks, drafts, rule
// evaluations or presence. Without `design` the form is untouched.
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

function group(id: number, key: string, label: string, sort: number): FieldGroup {
  return { id, key, label, type: 'section', icon: null, sort, is_collapsed: false }
}

const GROUPS: FieldGroup[] = [
  group(1, 'main', 'Main', 0),
  group(2, 'extra', 'Extra', 1),
  group(3, 'empty', 'Nothing yet', 2)
]

// title + amount in Main, notes in Extra, status in the header strip.
const ASSIGNMENTS = [
  { field: 'title', sort: 0, group_key: 'main', is_visible: true },
  { field: 'amount', sort: 1, group_key: 'main', is_visible: true },
  { field: 'notes', sort: 0, group_key: 'extra', is_visible: true },
  { field: 'status', sort: 0, group_key: '__header__', is_visible: true }
]

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
  groups: GROUPS,
  assignments: ASSIGNMENTS,
  ungrouped_sort: 99
}

// What GET /field-config returns for the saved layout: one row per placement.
const FIELD_CONFIG: CMSField[] = [
  field('title', 'Title', { group_key: 'main', sort: 0, layout_assigned: true }),
  field('amount', 'Amount', { group_key: 'main', sort: 1, layout_assigned: true }),
  field('notes', 'Notes', { group_key: 'extra', sort: 0, layout_assigned: true }),
  field('status', 'Status', { group_key: '__header__', sort: 0, layout_assigned: true })
]

const RECORD = { id: 1, title: 'First order', amount: '12.50', notes: 'Rush', status: 'open' }

type Cmd = { _method?: string; _path: string; _params?: Record<string, unknown> }

function makeClient() {
  const calls: Cmd[] = []
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      const p = cmd._path
      if (p === '/collection-layouts/active') return { data: LAYOUT }
      if (p === '/field-config/orders') return { data: FIELD_CONFIG }
      if (p === '/collections/orders') return { data: { display_name: 'Orders' } }
      if (p === '/items/orders/1') return { data: RECORD }
      // Writes and touches answer nothing; reads an empty list (panels, tasks,
      // comments, revisions…).
      if ((cmd._method ?? 'GET').toUpperCase() !== 'GET') return { data: null }
      return { data: [] }
    })
  }
  return { client, calls }
}

function makeDesign(over: Partial<LayoutDesign> = {}): LayoutDesign {
  return {
    selected: null,
    onSelect: vi.fn(),
    showHidden: false,
    inheritedFrom: () => null,
    dnd: {
      draggableProps: () => ({}),
      isDragging: () => false,
      dropSlot: () => null
    },
    ...over
  }
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
  for (let i = 0; i < 80 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
  // Let trailing effects (debounced persistence, rule timers) run too.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 1000))
  })
}

async function mount(props: Partial<Parameters<typeof ItemEditForm>[0]> = {}) {
  const { client, calls } = makeClient()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <ItemEditForm collection='orders' documentTitle={false} {...props} />
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  await settle(() => host.querySelectorAll('[data-field]').length >= 3)
  return { calls }
}

const fieldOrder = () =>
  [...host.querySelectorAll('[data-field]')].map((el) => el.getAttribute('data-field'))
const writes = (calls: Cmd[]) =>
  calls.filter((c) => (c._method ?? 'GET').toUpperCase() !== 'GET').map((c) => c._path)

describe('ItemEditForm design mode', () => {
  it('normal mode output unchanged', async () => {
    const { calls } = await mount({ itemId: '1' })
    expect(host.querySelectorAll('[data-design-target]').length).toBe(0)
    expect(fieldOrder()).toEqual(['title', 'amount', 'notes'])
    expect(calls.some((c) => c._path === '/collection-layouts/active')).toBe(true)
    // Byte-for-byte: the snapshot was taken BEFORE design mode existed.
    expect(host.innerHTML).toMatchSnapshot()
  })

  it('design mode renders the passed layout and never calls write endpoints', async () => {
    const record = { ...RECORD }
    const { calls } = await mount({
      design: { layout: LAYOUT, record, context: makeDesign() }
    })
    expect(fieldOrder()).toEqual(['title', 'amount', 'notes'])
    expect(calls.some((c) => c._path === '/collection-layouts/active')).toBe(false)
    expect(calls.some((c) => c._path === '/items/orders/1')).toBe(false)
    // Values come from the preview record.
    const title = host.querySelector('[data-field="title"] input') as HTMLInputElement | null
    expect(title?.value).toBe('First order')

    // Interact: click, type, press keys — nothing may reach a write endpoint.
    const input = title as HTMLInputElement
    await act(async () => {
      input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      input.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      input.focus()
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true })
      )
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'Changed')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    for (const b of host.querySelectorAll('button')) {
      await act(async () => {
        b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
    }
    await settle(() => false)
    expect(writes(calls)).toEqual([])
  })

  it('design mode wraps each placement in a DesignNode', async () => {
    const onSelect = vi.fn()
    await mount({
      design: { layout: LAYOUT, record: { ...RECORD }, context: makeDesign({ onSelect }) }
    })
    const targets = [...host.querySelectorAll('[data-design-target]')].map((el) =>
      el.getAttribute('data-design-target')
    )
    expect(targets.sort()).toEqual(
      [
        'field:title:main',
        'field:amount:main',
        'field:notes:extra',
        'header:status',
        'group:main',
        'group:extra',
        'group:empty'
      ].sort()
    )
    expect(targets.length).toBe(ASSIGNMENTS.length + GROUPS.length)

    // The empty section shows a drop zone; clicking a field selects it.
    expect(
      host.querySelector('[data-design-target="group:empty"] [data-design-drop-zone]')
    ).not.toBeNull()
    const amount = host.querySelector('[data-design-target="field:amount:main"]') as HTMLElement
    await act(async () => {
      ;(amount.querySelector('input') as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true })
      )
    })
    expect(onSelect).toHaveBeenLastCalledWith({
      kind: 'field',
      field: 'amount',
      group_key: 'main'
    } satisfies DesignTarget)
  })

  it('places fields where the draft layout puts them, not the saved one', async () => {
    const moved: ActiveLayoutData = {
      ...LAYOUT,
      assignments: [
        { field: 'notes', sort: 0, group_key: 'main', is_visible: true },
        { field: 'title', sort: 1, group_key: 'main', is_visible: true },
        { field: 'amount', sort: 0, group_key: 'extra', is_visible: true },
        { field: 'status', sort: 0, group_key: '__header__', is_visible: true }
      ]
    }
    await mount({ design: { layout: moved, record: { ...RECORD }, context: makeDesign() } })
    expect(fieldOrder()).toEqual(['notes', 'title', 'amount'])
    expect(host.querySelector('[data-design-target="field:amount:extra"]')).not.toBeNull()
  })

  it('shows hidden fields as faint placeholders when showHidden is on', async () => {
    const hidden: ActiveLayoutData = {
      ...LAYOUT,
      assignments: LAYOUT.assignments.map((a) =>
        a.field === 'amount' ? { ...a, overrides: { hidden: true } } : a
      )
    }
    await mount({
      design: { layout: hidden, record: { ...RECORD }, context: makeDesign({ showHidden: true }) }
    })
    const amount = host.querySelector('[data-design-target="field:amount:main"]')
    expect(amount).not.toBeNull()
    expect(amount?.querySelector('[data-design-hidden]')).not.toBeNull()
  })
})
