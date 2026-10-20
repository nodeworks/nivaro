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

type Cmd = {
  _method?: string
  _path: string
  _params?: Record<string, unknown>
  _body?: { assignments?: Array<Record<string, unknown>> }
}

// The server's POST /field-config/:col/project, reduced to what these
// fixtures use: one row per placement, overrides.hidden applied, unplaced
// fields unassigned.
const BASE: Record<string, CMSField> = Object.fromEntries(
  [
    field('title', 'Title'),
    field('amount', 'Amount'),
    field('notes', 'Notes'),
    field('status', 'Status')
  ].map((f) => [f.field, f])
)
function projectFake(assignments: Array<Record<string, unknown>>): CMSField[] {
  const placed = assignments.filter((a) => !String(a.field).startsWith('__'))
  const rows = placed.map((a) => {
    const ov = (a.overrides ?? null) as { hidden?: boolean } | null
    return {
      ...BASE[String(a.field)],
      group_key: (a.group_key as string | null) ?? null,
      sort: Number(a.sort),
      hidden: ov?.hidden ?? false,
      layout_assigned: true
    }
  })
  const names = new Set(placed.map((a) => a.field))
  for (const f of Object.values(BASE))
    if (!names.has(f.field)) rows.push({ ...f, group_key: null, layout_assigned: false })
  return rows
}

let projectDelayMs = 0

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
      if (p === '/field-config/orders/project') {
        // Answer late, like a real round trip: the canvas must keep the last
        // draft's rows on screen meanwhile.
        if (projectDelayMs) await new Promise((r) => setTimeout(r, projectDelayMs))
        return { data: projectFake(cmd._body?.assignments ?? []) }
      }
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

async function mount(
  props: Partial<Parameters<typeof ItemEditForm>[0]> = {},
  ready: () => boolean = () => host.querySelectorAll('[data-field]').length >= 3
) {
  const { client, calls } = makeClient()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const render = (p: Partial<Parameters<typeof ItemEditForm>[0]>) =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <ItemEditForm collection='orders' documentTitle={false} {...p} />
        </NivaroProvider>
      </QueryClientProvider>
    )
  await act(async () => render(props))
  await settle(ready)
  return { calls, rerender: (p: Partial<Parameters<typeof ItemEditForm>[0]>) => render(p) }
}

const fieldOrder = () =>
  [...host.querySelectorAll('[data-field]')].map((el) => el.getAttribute('data-field'))
// Every non-GET that reached the network except the draft-rows read.
const writes = (calls: Cmd[]) =>
  calls
    .filter((c) => (c._method ?? 'GET').toUpperCase() !== 'GET')
    .map((c) => c._path)
    .filter((p) => p !== '/field-config/orders/project')

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
    // Hears every write ATTEMPT, before the read-only client refuses it — so
    // the form's own gates (recap touch, live sync, drafts, locks, rules) are
    // what this test checks, not just the client.
    const onRefusedWrite = vi.fn()
    const { calls } = await mount({
      design: { layout: LAYOUT, record, context: makeDesign(), onRefusedWrite }
    })
    expect(fieldOrder()).toEqual(['title', 'amount', 'notes'])
    expect(calls.some((c) => c._path === '/collection-layouts/active')).toBe(false)
    expect(calls.some((c) => c._path === '/items/orders/1')).toBe(false)
    // The draft's placements go to the server's formatter, as they are.
    const project = calls.filter((c) => c._path === '/field-config/orders/project')
    expect(project.length).toBeGreaterThan(0)
    expect(project[0]._method).toBe('POST')
    expect(project[0]._body?.assignments).toEqual(LAYOUT.assignments)
    expect(calls.some((c) => c._path === '/field-config/orders')).toBe(false)
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
    expect(onRefusedWrite).not.toHaveBeenCalled()
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
  // Tabs/steps: Details holds a hidden field, Later is hidden by its
  // visible_when (the record's status is open), Empty holds nothing.
  const tabsLayout = (mode: 'tabs' | 'steps'): ActiveLayoutData => ({
    layout: { ...(LAYOUT.layout as NonNullable<ActiveLayoutData['layout']>), tab_mode: mode },
    groups: [
      { ...group(11, 't1', 'Details', 0), type: 'tab' },
      {
        ...group(12, 't2', 'Later', 1),
        type: 'tab',
        visible_when: JSON.stringify([{ field: 'status', op: 'eq', value: 'closed' }])
      } as FieldGroup,
      { ...group(13, 't3', 'Empty', 2), type: 'tab' }
    ],
    assignments: [
      { field: 'title', sort: 0, group_key: 't1', is_visible: true },
      { field: 'amount', sort: 1, group_key: 't1', is_visible: true, overrides: { hidden: true } },
      { field: 'notes', sort: 0, group_key: 't2', is_visible: true }
    ],
    ungrouped_sort: 99
  })

  for (const mode of ['tabs', 'steps'] as const) {
    it(`${mode}: hidden fields and rule-hidden ${mode} stay faint; an empty one is a drop zone`, async () => {
      const onRefusedWrite = vi.fn()
      await mount(
        {
          design: {
            layout: tabsLayout(mode),
            record: { ...RECORD },
            context: makeDesign({ showHidden: true }),
            onRefusedWrite
          }
        },
        () => !!host.querySelector('[data-field="title"]')
      )
      // The hidden field in the active tab shows as a faint placeholder.
      const amount = host.querySelector('[data-design-target="field:amount:t1"]')
      expect(amount?.querySelector('[data-design-hidden] [data-field="amount"]')).not.toBeNull()
      // The visible_when tab is kept, faint, and selectable.
      const later = host.querySelector('[data-design-target="group:t2"]')
      expect(later).not.toBeNull()
      expect(later?.hasAttribute('data-design-hidden')).toBe(true)
      // Clicking the Empty tab switches to it (and selects it): a drop zone.
      const empty = host.querySelector('[data-design-target="group:t3"]') as HTMLElement
      const button = (
        empty.matches('button') ? empty : empty.querySelector('button')
      ) as HTMLElement
      await act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
      await settle(() => !!host.querySelector('[data-design-drop-zone]'))
      expect(host.querySelector('[data-design-drop-zone]')).not.toBeNull()
      // The pane itself is the drop target for the tab's fields.
      const body = host.querySelector('[data-design-drop-body="t3"]')
      expect(body?.parentElement?.contains(host.querySelector('[data-design-drop-zone]'))).toBe(
        true
      )
      expect(onRefusedWrite).not.toHaveBeenCalled()
    })
  }

  it('tabs: an empty General tab offers no drop zone (it is not one place to drop)', async () => {
    const base = tabsLayout('tabs')
    const layout: ActiveLayoutData = {
      ...base,
      groups: [...base.groups, group(14, 's1', 'Section', 3)]
    }
    localStorage.setItem('nvr_tab_orders', '__general__')
    try {
      await mount(
        { design: { layout, record: { ...RECORD }, context: makeDesign() } },
        () => !!host.querySelector('[data-tab-key="__general__"]')
      )
      expect(host.querySelector('[data-tab-key="__general__"]')).not.toBeNull()
      expect(host.querySelector('[data-design-drop-zone]')).toBeNull()
      expect(host.querySelector('[data-design-drop-body]')).toBeNull()
    } finally {
      localStorage.removeItem('nvr_tab_orders')
    }
  })

  it(`tabs: without showHidden the rule-hidden tab and hidden field stay out`, async () => {
    await mount(
      { design: { layout: tabsLayout('tabs'), record: { ...RECORD }, context: makeDesign() } },
      () => !!host.querySelector('[data-field="title"]')
    )
    expect(host.querySelector('[data-design-target="group:t2"]')).toBeNull()
    expect(host.querySelector('[data-field="amount"]')).toBeNull()
    expect(host.querySelector('[data-design-hidden]')).toBeNull()
  })
  it('a draft edit re-renders in place: no loader, no remount', async () => {
    projectDelayMs = 120
    try {
      const context = makeDesign()
      const record = { ...RECORD }
      const { rerender, calls } = await mount({ design: { layout: LAYOUT, record, context } })
      const mainBefore = host.querySelector('[data-design-target="group:main"]')
      const inputBefore = host.querySelector('[data-field="title"] input')
      expect(mainBefore).not.toBeNull()

      // Watch every DOM change from here on for the full-page loader.
      let sawLoader = false
      const mo = new MutationObserver(() => {
        if (host.textContent?.includes('Loading record')) sawLoader = true
      })
      mo.observe(host, { childList: true, subtree: true, characterData: true })

      // Move notes into Main, then amount into Extra — two draft edits.
      const step1: ActiveLayoutData = {
        ...LAYOUT,
        assignments: [
          ...LAYOUT.assignments.filter((a) => a.field !== 'notes'),
          { field: 'notes', sort: 2, group_key: 'main', is_visible: true }
        ]
      }
      const step2: ActiveLayoutData = {
        ...step1,
        assignments: step1.assignments.map((a) =>
          a.field === 'amount' ? { ...a, group_key: 'extra', sort: 0 } : a
        )
      }
      for (const layout of [step1, step2]) {
        await act(async () => rerender({ design: { layout, record, context } }))
        // The new rows are in flight; the old ones stay on screen.
        expect(host.textContent).not.toContain('Loading record')
        await settle(
          () => !!host.querySelector(`[data-design-target="field:notes:main"]`) && !sawLoader
        )
      }
      mo.disconnect()

      expect(sawLoader).toBe(false)
      expect(host.querySelector('[data-design-target="field:amount:extra"]')).not.toBeNull()
      expect(fieldOrder()).toEqual(['title', 'notes', 'amount'])
      // Same DOM nodes: the form body was updated, never remounted.
      expect(host.querySelector('[data-design-target="group:main"]')).toBe(mainBefore)
      expect(host.querySelector('[data-field="title"] input')).toBe(inputBefore)
      expect(
        calls.filter((c) => c._path === '/field-config/orders/project').length
      ).toBeGreaterThanOrEqual(3)
    } finally {
      projectDelayMs = 0
    }
  })
})
