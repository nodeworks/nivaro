// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, type ReactNode, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider, useNivaroClient } from '../context'
import { post } from '../lib/commands'
import type { ActiveLayoutData } from './item-edit/types'
import type { LayoutDesign } from './layout-editor/design-context'
import { RecordDrilldownSheet } from './RecordDrilldownSheet'
import { type ReadViewLayout, RecordReadView } from './RecordReadView'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const FIELDS = [
  { field: 'id', type: 'integer', label: 'ID' },
  { field: 'title', type: 'string', label: 'Title' },
  { field: 'amount', type: 'integer', label: 'Amount' },
  { field: 'secret', type: 'string', label: 'Secret' },
  { field: 'blank', type: 'string', label: 'Blank' }
]

const LAYOUT = {
  layout: {
    id: 7,
    name: 'Unit summary',
    header_fields: ['title'],
    hide_empty: true,
    sheet_width: 820,
    display_mode: 'read'
  },
  groups: [
    { key: 'main', label: 'Main', type: 'section', sort: 1, read_width: 'half' },
    { key: 'empty', label: 'Nothing yet', type: 'section', sort: 2 }
  ],
  assignments: [
    { field: 'title', group_key: 'main', sort: 1, label_override: null, is_visible: true },
    { field: 'amount', group_key: 'main', sort: 2, label_override: null, is_visible: true },
    { field: 'secret', group_key: 'main', sort: 3, label_override: null, is_visible: false },
    { field: 'blank', group_key: 'main', sort: 4, label_override: null, is_visible: true },
    { field: '__comments__', group_key: null, sort: 5, label_override: null, is_visible: true }
  ]
}

function mockClient() {
  const calls: Array<{ method: string; path: string }> = []
  const client = {
    request: vi.fn(async (cmd: { _method?: string; _path?: string }) => {
      calls.push({ method: cmd._method ?? 'GET', path: cmd._path ?? '' })
      if (cmd._path === '/collections/units') return { data: { fields: FIELDS, relations: [] } }
      if (cmd._path === '/items/units/5')
        return { data: { id: 5, title: 'Live pump', amount: 3, secret: 's', blank: null } }
      if (cmd._path === '/field-config/units') return { data: FIELDS }
      if (cmd._path === '/collection-layouts/detail/units') return { data: LAYOUT }
      return { data: null }
    })
  } as unknown as NivaroClient
  return { client, calls }
}

function design(over: Partial<LayoutDesign> = {}): LayoutDesign {
  return {
    selected: null,
    onSelect: vi.fn(),
    showHidden: false,
    inheritedFrom: () => null,
    dnd: { draggableProps: () => ({}), isDragging: () => false, dropSlot: () => null },
    ...over
  }
}

const RECORD = { id: 5, title: 'Draft pump', amount: 42, secret: 'x', blank: null }

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

async function mount(client: NivaroClient, node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client}>{node}</NivaroProvider>
      </QueryClientProvider>
    )
  })
  // Let lazy chunks and the collection meta read settle.
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 10)))
}

const targets = (el: ParentNode = document) =>
  [...el.querySelectorAll('[data-design-target]')].map((n) => n.getAttribute('data-design-target'))

describe('RecordReadView design mode', () => {
  it('read view renders passed layout in design mode', async () => {
    const { client, calls } = mockClient()
    const d = design()
    await mount(
      client,
      <RecordReadView
        collection='units'
        design={{ layout: LAYOUT as unknown as ActiveLayoutData, record: RECORD, context: d }}
      />
    )
    // Values come from the preview record, never a record read.
    expect(host.textContent).toContain('Draft pump')
    expect(host.textContent).toContain('42')
    expect(host.textContent).not.toContain('Live pump')
    expect(calls.some((c) => c.path.startsWith('/items/units'))).toBe(false)
    expect(calls.some((c) => c.path.startsWith('/collection-layouts'))).toBe(false)
    expect(calls.some((c) => c.path.startsWith('/revisions'))).toBe(false)
    expect(calls.every((c) => c.method === 'GET')).toBe(true)

    const t = targets(host)
    expect(t).toContain('group:main')
    expect(t).toContain('header:title')
    expect(t).toContain('field:amount:main')
    // hide_empty never drops a plain field — still on the canvas.
    expect(t).toContain('field:blank:main')
    // An empty section stays as a drop zone; a slot is selectable.
    expect(t).toContain('group:empty')
    expect(host.querySelector('[data-design-drop="empty"]')).not.toBeNull()
    expect(t).toContain('slot:__comments__:')
    // A hidden field is off the canvas unless showHidden.
    expect(t).not.toContain('field:secret:main')
    // The board width still comes from the passed layout.
    expect(host.querySelector('[data-read-section="main"]')?.getAttribute('data-read-width')).toBe(
      'half'
    )

    const amount = host.querySelector('[data-design-target="field:amount:main"]') as HTMLElement
    act(() => amount.click())
    expect(d.onSelect).toHaveBeenCalledWith({ kind: 'field', field: 'amount', group_key: 'main' })
  })

  it('shows hidden and empty placements when showHidden', async () => {
    const { client } = mockClient()
    const emptyHeader = { ...RECORD, title: null }
    await mount(
      client,
      <RecordReadView
        collection='units'
        design={{
          layout: LAYOUT as unknown as ActiveLayoutData,
          record: emptyHeader,
          context: design({ showHidden: true })
        }}
      />
    )
    const t = targets(host)
    expect(t).toContain('field:secret:main')
    expect(t).toContain('header:title')
    const secret = host.querySelector('[data-design-target="field:secret:main"]') as HTMLElement
    expect(secret.querySelector('[data-design-hidden]')).not.toBeNull()
  })

  it('read view unchanged without design', async () => {
    const { client, calls } = mockClient()
    await mount(
      client,
      <RecordReadView
        collection='units'
        itemId='5'
        layoutData={LAYOUT as unknown as ReadViewLayout}
      />
    )
    expect(host.querySelector('[data-design-target]')).toBeNull()
    expect(host.querySelector('[data-design-drop]')).toBeNull()
    expect(calls.some((c) => c.path === '/items/units/5')).toBe(true)
    expect(host.textContent).toContain('Live pump')
    // Same field order; hidden field gone; empty section not rendered.
    const labels = [...host.querySelectorAll('[data-read-section="main"] dt')].map((n) =>
      n.textContent?.trim()
    )
    expect(labels).toEqual(['Amount', 'Blank'])
    expect(host.querySelector('[data-read-section="empty"]')).toBeNull()
  })
})

describe('RecordDrilldownSheet design mode', () => {
  it('renders the passed detail layout inline at its sheet width without fetching it', async () => {
    const { client, calls } = mockClient()
    await mount(
      client,
      <RecordDrilldownSheet
        collection='units'
        itemId='5'
        onClose={() => {}}
        design={{
          layout: LAYOUT as unknown as ActiveLayoutData,
          record: RECORD,
          context: design()
        }}
      />
    )
    expect(calls.some((c) => c.path.startsWith('/collection-layouts'))).toBe(false)
    // Inline (no modal dialog to lock the editor's side panels).
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    const frame = host.querySelector('[data-design-sheet]') as HTMLElement
    expect(frame.style.width).toBe('820px')
    expect(host.textContent).toContain('Draft pump')
    expect(targets(host)).toContain('field:amount:main')
  })
})

// Relation fixtures: an M2O owner, an O2M lines grid and an M2M tags alias.
const REL_FIELDS = [
  ...FIELDS,
  { field: 'owner', type: 'integer', label: 'Owner' },
  { field: 'lines', type: 'alias', label: 'Lines' },
  { field: 'tags', type: 'alias', label: 'Tags' }
]
const REL_RELATIONS = [
  { many_collection: 'units', many_field: 'owner', one_collection: 'people' },
  { many_collection: 'lines', many_field: 'unit_id', one_collection: 'units', one_field: 'lines' },
  {
    many_collection: 'units_tags',
    many_field: 'units_id',
    one_collection: 'units',
    one_field: 'tags',
    junction_field: 'tags_id'
  }
]
const relAssign = (field: string, sort: number) => ({
  field,
  group_key: 'main',
  sort,
  label_override: null,
  is_visible: true
})
const REL_LAYOUT = {
  ...LAYOUT,
  assignments: [
    ...LAYOUT.assignments,
    relAssign('owner', 6),
    relAssign('lines', 7),
    relAssign('tags', 8)
  ]
}

function relClient() {
  const calls: Array<{ method: string; path: string }> = []
  const client = {
    request: vi.fn(async (cmd: { _method?: string; _path?: string }) => {
      calls.push({ method: cmd._method ?? 'GET', path: cmd._path ?? '' })
      if (cmd._path === '/collections/units')
        return { data: { fields: REL_FIELDS, relations: REL_RELATIONS } }
      if (cmd._path === '/collections/people') return { data: { fields: [], relations: [] } }
      if (cmd._path === '/items/people/9') return { data: { id: 9, name: 'Ada Owner' } }
      return { data: null }
    })
  } as unknown as NivaroClient
  return { client, calls }
}

describe('design mode fixes', () => {
  it('sheet renders a draft whose layout row is null', async () => {
    const { client } = mockClient()
    const nullLayout = { layout: null, groups: LAYOUT.groups, assignments: LAYOUT.assignments }
    await mount(
      client,
      <RecordDrilldownSheet
        collection='units'
        itemId='5'
        onClose={() => {}}
        design={{
          layout: nullLayout as unknown as ActiveLayoutData,
          record: RECORD,
          context: design()
        }}
      />
    )
    const frame = host.querySelector('[data-design-sheet]') as HTMLElement
    expect(frame).not.toBeNull()
    expect(frame.textContent).toContain('Units')
  })

  it('a relation value on the sheet canvas never drills', async () => {
    const { client, calls } = relClient()
    await mount(
      client,
      <RecordDrilldownSheet
        collection='units'
        itemId='5'
        onClose={() => {}}
        design={{
          layout: REL_LAYOUT as unknown as ActiveLayoutData,
          record: { ...RECORD, owner: 9 },
          context: design()
        }}
      />
    )
    const owner = host.querySelector('[data-design-target="field:owner:main"]') as HTMLElement
    expect(owner.textContent).toContain('Ada Owner')
    // Plain label, not a drill button.
    expect(owner.querySelector('button')).toBeNull()
    await act(async () => owner.querySelector('dd')?.click())
    expect(host.querySelector('[aria-label="Back"]')).toBeNull()
    expect(host.textContent).toContain('Draft pump')
    expect(calls.some((c) => c.path.startsWith('/collection-layouts'))).toBe(false)
  })

  it('no child or link reads without a preview record', async () => {
    const { client, calls } = relClient()
    await mount(
      client,
      <RecordReadView
        collection='units'
        design={{
          layout: REL_LAYOUT as unknown as ActiveLayoutData,
          record: null,
          context: design()
        }}
      />
    )
    expect(targets(host)).toContain('field:lines:main')
    expect(targets(host)).toContain('field:tags:main')
    expect(calls.some((c) => c.path.startsWith('/items/lines'))).toBe(false)
    expect(calls.some((c) => c.path.startsWith('/items/units_tags'))).toBe(false)
    expect(calls.some((c) => c.path.startsWith('/collections/units_tags'))).toBe(false)
  })
})

describe('design mode read-only client', () => {
  it('a write from inside the read view canvas is refused before it leaves', async () => {
    const { client, calls } = mockClient()
    const refused: Array<{ method: string; path: string }> = []
    function Writer() {
      const c = useNivaroClient()
      useEffect(() => {
        c.request(post('/comments', { text: 'x' })).catch(() => {})
      }, [c])
      return <span>writer</span>
    }
    await mount(
      client,
      <RecordReadView
        collection='units'
        renderSlot={(key) => (key === '__comments__' ? <Writer /> : null)}
        design={{
          layout: LAYOUT as unknown as ActiveLayoutData,
          record: RECORD,
          context: design(),
          onRefusedWrite: (w) => refused.push(w)
        }}
      />
    )
    expect(host.textContent).toContain('writer')
    expect(refused).toEqual([{ method: 'POST', path: '/comments' }])
    expect(calls.some((c) => c.method !== 'GET')).toBe(false)
  })
})
