// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { type LayoutBundle, newGroup, newPlacement, type PlacementRow } from '../../lib/layout-ops'
import { DesignNode } from './DesignNode'
import { type DesignTarget, type LayoutDesign, LayoutDesignContext } from './design-context'
import { BulkInspector } from './inspector/BulkInspector'
import { PlacementsTable } from './PlacementsTable'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Element.prototype.scrollIntoView ??= () => {}

// #2583 multi-select on the canvas and in the bulk panel; #2602 placements table.

const f = (field: string, group_key: string | null): DesignTarget => ({
  kind: 'field',
  field,
  group_key
})

const place = (field: string, group: string, sort: number, over: Partial<PlacementRow> = {}) => ({
  ...newPlacement(field, group),
  sort,
  ...over
})

function bundle(): LayoutBundle {
  return {
    layout: { id: 7, collection: 'orders', name: 'Form', layout_type: 'grouped' },
    groups: [
      { ...newGroup('main', 'Main', 'section', null), sort: 0 },
      { ...newGroup('extra', 'Extra', 'section', null), sort: 1 }
    ],
    placements: [
      place('title', 'main', 0, { col_span: 6 }),
      place('amount', 'main', 1, { overrides: { required: true } }),
      place('notes', 'extra', 0)
    ],
    rev: 'r'
  }
}

const FIELDS = [
  { field: 'title', type: 'string', label: 'Title' },
  { field: 'amount', type: 'decimal', label: 'Amount' },
  { field: 'notes', type: 'text', label: 'Notes' }
]

const client = {
  request: vi.fn(async (cmd: { _path: string }) =>
    cmd._path === '/collections/orders' ? { data: { fields: FIELDS, relations: [] } } : { data: [] }
  )
}

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

async function render(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>{node}</NivaroProvider>
      </QueryClientProvider>
    )
  })
  for (let i = 0; i < 6; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
}

const button = (name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) as
    | HTMLButtonElement
    | undefined

describe('canvas multi-select', () => {
  it('Shift- and ⌘-click ask to add; every selected node is outlined', () => {
    const onSelect = vi.fn()
    const d: LayoutDesign = {
      selected: f('b', 'main'),
      selection: [f('a', 'main'), f('b', 'main')],
      onSelect,
      showHidden: false,
      inheritedFrom: () => null,
      dnd: { draggableProps: () => ({}), isDragging: () => false, dropSlot: () => null }
    }
    act(() =>
      root.render(
        <LayoutDesignContext.Provider value={d}>
          <DesignNode target={f('a', 'main')}>
            <span>a</span>
          </DesignNode>
          <DesignNode target={f('c', 'main')}>
            <span>c</span>
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    const [a, c] = [...host.querySelectorAll<HTMLElement>('[data-design-target]')]
    expect(a.getAttribute('data-selected')).toBe('true')
    expect(c.getAttribute('data-selected')).toBe(null)
    act(() => {
      c.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    })
    expect(onSelect).toHaveBeenLastCalledWith(f('c', 'main'), { additive: true })
    act(() => {
      c.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))
    })
    expect(onSelect).toHaveBeenLastCalledWith(f('c', 'main'), { additive: true })
    act(() => c.click())
    expect(onSelect).toHaveBeenLastCalledWith(f('c', 'main'))
  })
})

describe('bulk panel', () => {
  it('one width or required change is one apply for every selected field', async () => {
    const apply = vi.fn()
    const onSelection = vi.fn()
    const sel = [f('title', 'main'), f('amount', 'main'), f('notes', 'extra')]
    await render(
      <BulkInspector
        bundle={bundle()}
        selection={sel}
        apply={apply}
        collection='orders'
        onSelection={onSelection}
      />
    )
    expect(host.textContent).toContain('3 items selected')
    expect(host.textContent).toContain('1 of 3 now.')
    act(() => button('½')?.click())
    expect(apply).toHaveBeenCalledTimes(1)
    const [ops, opts] = apply.mock.calls[0]
    expect(ops).toHaveLength(2) // title is already ½
    expect(opts.label).toBe('Set the width of 3 items to ½')
    const required = host.querySelector('[data-setting="bulk.required"] [role="switch"]')
    act(() => (required as HTMLElement).click())
    expect(apply).toHaveBeenCalledTimes(2)
    expect(apply.mock.calls[1][0]).toHaveLength(2)
    expect(apply.mock.calls[1][1].label).toBe('Make 3 fields required')
    act(() =>
      (host.querySelector('[aria-label="Take Title out of the selection"]') as HTMLElement).click()
    )
    expect(onSelection).toHaveBeenLastCalledWith([f('amount', 'main'), f('notes', 'extra')])
    act(() => button('Clear the selection')?.click())
    expect(onSelection).toHaveBeenLastCalledWith([])
  })
})

describe('placements table', () => {
  it('lists every field by section; cells edit through ops; rows select', async () => {
    const apply = vi.fn()
    const onSelect = vi.fn()
    await render(
      <PlacementsTable
        bundle={bundle()}
        collection='orders'
        apply={apply}
        flush={() => {}}
        selection={[f('title', 'main')]}
        onSelect={onSelect}
        onSelection={() => {}}
      />
    )
    const zones = [...host.querySelectorAll('[data-table-zone]')].map((z) =>
      z.getAttribute('data-table-zone')
    )
    expect(zones).toEqual(['main', 'extra'])
    const rows = [...host.querySelectorAll<HTMLElement>('[data-table-row]')]
    expect(rows.map((r) => r.getAttribute('data-table-row'))).toEqual([
      'field:title:main',
      'field:amount:main',
      'field:notes:extra'
    ])
    expect(rows[0].getAttribute('aria-selected')).toBe('true')

    const req = rows[1].querySelector('[aria-label="Required: Amount"]') as HTMLElement
    expect(req.getAttribute('data-state')).toBe('checked')
    act(() => req.click())
    expect(apply).toHaveBeenLastCalledWith(
      [
        {
          op: 'update_placement',
          at: { field: 'amount', group_key: 'main' },
          patch: { overrides: null }
        }
      ],
      { label: 'Make Amount optional' }
    )

    const label = rows[2].querySelector('input') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      label.focus()
      setter?.call(label, 'Remarks')
      label.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(apply).toHaveBeenLastCalledWith(
      [
        {
          op: 'update_placement',
          at: { field: 'notes', group_key: 'extra' },
          patch: { overrides: { label: 'Remarks' } }
        }
      ],
      { label: 'Rename Notes', text: true }
    )

    act(() => {
      rows[2]
        .querySelector('td:nth-child(2)')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    })
    expect(onSelect).toHaveBeenLastCalledWith(f('notes', 'extra'), { additive: true })
    act(() => (rows[1].querySelector('[aria-label="Select Amount"]') as HTMLElement).click())
    expect(onSelect).toHaveBeenLastCalledWith(f('amount', 'main'), { additive: true })
  })
})
