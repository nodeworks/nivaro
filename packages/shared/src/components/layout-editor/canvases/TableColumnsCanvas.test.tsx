// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type LayoutBundle, newPlacement } from '../../../lib/layout-ops'
import { type LayoutDesign, LayoutDesignContext } from '../design-context'
import { LayoutDndProvider, useLayoutDnd } from '../dnd/LayoutDndProvider'
import { orderAfterDrop } from '../dnd/order'
import { TableColumnsCanvas } from './TableColumnsCanvas'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function bundle(): LayoutBundle {
  return {
    layout: { id: 3, collection: 'lines', layout_type: 'table' },
    groups: [],
    placements: [
      { ...newPlacement('price', null), sort: 1 },
      { ...newPlacement('name', null), sort: 0 },
      { ...newPlacement('qty', null), sort: 2 },
      { ...newPlacement('note', '__apply_values__'), sort: 0 }
    ],
    rev: 'r1'
  }
}

const FIELDS = [
  { field: 'name', label: 'Name' },
  { field: 'price', label: 'Price' },
  { field: 'qty', label: 'Qty' },
  { field: 'note', label: 'Note' },
  { field: 'sku', label: 'SKU' }
]

// Column cells side by side, the zone bodies stacked below.
const RECTS: Record<string, [number, number, number, number]> = {
  'field:name:': [0, 0, 100, 30],
  'field:price:': [100, 0, 100, 30],
  'field:qty:': [200, 0, 100, 30],
  'field:note:__apply_values__': [0, 200, 60, 30],
  columns: [0, 0, 300, 40],
  __apply_values__: [0, 200, 300, 60],
  __create_with_defaults__: [0, 300, 300, 60]
}
const domRect = ([x, y, w, h]: [number, number, number, number]) =>
  ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h }) as DOMRect

let host: HTMLDivElement
let root: Root
const original = Element.prototype.getBoundingClientRect
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const k = this.getAttribute('data-design-target') ?? this.getAttribute('data-table-body')
    return domRect(RECTS[k ?? ''] ?? [0, 0, 0, 0])
  }
  Element.prototype.scrollIntoView = () => {}
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  Element.prototype.getBoundingClientRect = original
})

const click = (label: string) =>
  act(() => (host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement).click())
const tick = () => act(() => new Promise((r) => setTimeout(r, 0)))
const key = (code: string, target: EventTarget = document) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }))
  })

function Canvas({ apply, b = bundle() }: { apply: (...a: unknown[]) => void; b?: LayoutBundle }) {
  const dnd = useLayoutDnd()
  const design: LayoutDesign = {
    selected: null,
    onSelect: () => {},
    showHidden: false,
    inheritedFrom: () => null,
    dnd
  }
  return (
    <LayoutDesignContext.Provider value={design}>
      <TableColumnsCanvas bundle={b} apply={apply} collection='lines' fields={FIELDS} />
    </LayoutDesignContext.Provider>
  )
}

function renderDnd(apply: (...a: unknown[]) => void, b = bundle()) {
  act(() =>
    root.render(
      <LayoutDndProvider bundle={b} apply={apply}>
        <Canvas apply={apply} b={b} />
      </LayoutDndProvider>
    )
  )
}

const node = (k: string) => host.querySelector(`[data-design-target="${k}"]`) as HTMLElement

describe('TableColumnsCanvas', () => {
  it('renders columns in sort order in a table-fixed header like the real grid', () => {
    act(() =>
      root.render(
        <TableColumnsCanvas bundle={bundle()} apply={vi.fn()} collection='lines' fields={FIELDS} />
      )
    )
    const table = host.querySelector('table[data-table-header]') as HTMLElement
    expect(table.className).toContain('table-fixed')
    expect(table.querySelector('thead')?.className).toContain('bg-slate-50')
    const ths = [...table.querySelectorAll('thead tr th')]
    expect(ths.map((c) => c.getAttribute('data-table-cell'))).toEqual(['name', 'price', 'qty'])
    expect(ths[0].className).toContain('text-[11px]')
    expect(table.querySelectorAll('thead tr')).toHaveLength(1)
    expect(host.querySelector('[data-table-zone="__apply_values__"]')?.textContent).toContain(
      'Note'
    )
    expect(host.textContent).toContain('Create with defaults')
    expect(host.textContent).not.toMatch(/\/12/)
    expect(host.querySelector('button[aria-label*="wider"]')).toBeNull()
  })

  it('reorders with one move op from the arrow buttons', () => {
    const apply = vi.fn()
    act(() =>
      root.render(<TableColumnsCanvas bundle={bundle()} apply={apply} collection='lines' />)
    )
    click('Move Name right')
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith(
      [{ op: 'move', from: { field: 'name', group_key: null }, to_group_key: null, index: 1 }],
      { label: 'Move Name' }
    )
  })

  it('arrow moves count the zone the way the op does, hidden sentinels included', () => {
    // A legacy widget sentinel sits between Name and Price in the columns zone.
    const b = bundle()
    b.placements.push({ ...newPlacement('__widget_5__', null), sort: 0.5, widget_id: 5 })
    const apply = vi.fn()
    act(() => root.render(<TableColumnsCanvas bundle={b} apply={apply} collection='lines' />))
    // Shown: name, price, qty. Members: name, __widget_5__, price, qty.
    click('Move Name right')
    expect(apply.mock.calls[0][0]).toEqual([
      { op: 'move', from: { field: 'name', group_key: null }, to_group_key: null, index: 2 }
    ])
    click('Move Qty left')
    expect(apply.mock.calls[1][0]).toEqual([
      { op: 'move', from: { field: 'qty', group_key: null }, to_group_key: null, index: 2 }
    ])
  })

  it('every zone adds a field with one place op, offering only fields not in it', async () => {
    const apply = vi.fn()
    act(() =>
      root.render(
        <TableColumnsCanvas bundle={bundle()} apply={apply} collection='lines' fields={FIELDS} />
      )
    )
    act(() =>
      (
        host.querySelector('button[aria-label="Add field to Create with defaults"]') as HTMLElement
      ).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    )
    await tick()
    const items = [...document.querySelectorAll('[cmdk-item]')].map((i) => i.textContent)
    expect(items).toEqual(['Name', 'Note', 'Price', 'Qty', 'SKU'])
    act(() => (document.querySelector('[cmdk-item]') as HTMLElement).click())
    await tick()
    expect(apply).toHaveBeenCalledWith(
      [{ op: 'place', field: 'name', group_key: '__create_with_defaults__', index: 0 }],
      { label: 'Add Name' }
    )
  })

  it('a zone drag target is registered for the empty form zones', () => {
    const apply = vi.fn()
    renderDnd(apply)
    // The empty Create with defaults zone has a drop pane; its hint no longer says to use the Add panel.
    expect(host.querySelector('[data-design-drop-body="__create_with_defaults__"]')).not.toBeNull()
    expect(
      host.querySelector('[data-table-zone="__create_with_defaults__"]')?.textContent
    ).not.toContain('Add panel')
  })

  it('a keyboard drag of a column into the empty zone is one move op', async () => {
    const apply = vi.fn()
    renderDnd(apply)
    const q = node('field:qty:')
    q.focus()
    key('Space', q)
    await tick()
    // qty → (columns have no later stop) → Apply values field note → defaults zone
    for (let i = 0; i < 6; i++) {
      key('ArrowDown')
      await tick()
      if (
        host.querySelector(
          '[data-design-drop-body="__create_with_defaults__"][data-design-drop-indicator]'
        )
      )
        break
    }
    key('Space')
    await tick()
    expect(apply).toHaveBeenCalledTimes(1)
    const ops = apply.mock.calls[0][0] as { op: string; to_group_key: string }[]
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({
      op: 'move',
      from: { field: 'qty', group_key: null },
      to_group_key: '__create_with_defaults__',
      index: 0
    })
  })

  it('a keyboard drag of a column across the header is one move op', async () => {
    const apply = vi.fn()
    renderDnd(apply)
    const n = node('field:name:')
    n.focus()
    key('Space', n)
    await tick()
    key('ArrowRight')
    await tick()
    key('ArrowRight')
    await tick()
    key('Space')
    await tick()
    expect(apply).toHaveBeenCalledTimes(1)
    const ops = apply.mock.calls[0][0]
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ op: 'move', from: { field: 'name', group_key: null } })
    expect(ops[0].index).toBeGreaterThan(0)
  })

  it('move.index counts the rest of the zone: left, middle, end', () => {
    const b = bundle()
    const f = (field: string) => ({ kind: 'field' as const, field, group_key: null })
    // order: name, price, qty
    expect(orderAfterDrop(b, f('qty'), f('name'), 'before')).toEqual([
      { op: 'move', from: { field: 'qty', group_key: null }, to_group_key: null, index: 0 }
    ])
    expect(orderAfterDrop(b, f('name'), f('price'), 'after')).toEqual([
      { op: 'move', from: { field: 'name', group_key: null }, to_group_key: null, index: 1 }
    ])
    expect(orderAfterDrop(b, f('name'), f('qty'), 'after')).toEqual([
      { op: 'move', from: { field: 'name', group_key: null }, to_group_key: null, index: 2 }
    ])
  })
})
