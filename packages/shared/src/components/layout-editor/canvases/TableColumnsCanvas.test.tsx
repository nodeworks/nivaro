// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type LayoutBundle, newPlacement } from '../../../lib/layout-ops'
import { orderAfterDrop } from '../dnd/order'
import { TableColumnsCanvas } from './TableColumnsCanvas'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function bundle(): LayoutBundle {
  return {
    layout: { id: 3, collection: 'lines', layout_type: 'table' },
    groups: [],
    placements: [
      { ...newPlacement('price', null), sort: 1, col_span: 3 },
      { ...newPlacement('name', null), sort: 0, col_span: 6 },
      { ...newPlacement('qty', null), sort: 2, col_span: 3 },
      { ...newPlacement('note', '__apply_values__'), sort: 0 }
    ],
    rev: 'r1'
  }
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
})

const click = (label: string) =>
  act(() => (host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement).click())

describe('TableColumnsCanvas', () => {
  it('renders columns in sort order and the form zones', () => {
    act(() =>
      root.render(<TableColumnsCanvas bundle={bundle()} apply={vi.fn()} collection='lines' />)
    )
    const cells = [...host.querySelectorAll('[data-table-header] [data-table-cell]')]
    expect(cells.map((c) => c.getAttribute('data-table-cell'))).toEqual(['name', 'price', 'qty'])
    expect(host.querySelector('[data-table-zone="__apply_values__"]')?.textContent).toContain(
      'Note'
    )
    expect(host.textContent).toContain('Create with defaults')
  })

  it('reorders with one move op', () => {
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

  it('a drag drop between columns is one move op', () => {
    const ops = orderAfterDrop(
      bundle(),
      { kind: 'field', field: 'qty', group_key: null },
      { kind: 'field', field: 'name', group_key: null },
      'before'
    )
    expect(ops).toEqual([
      { op: 'move', from: { field: 'qty', group_key: null }, to_group_key: null, index: 0 }
    ])
  })

  it('width change emits update_placement', () => {
    const apply = vi.fn()
    act(() =>
      root.render(<TableColumnsCanvas bundle={bundle()} apply={apply} collection='lines' />)
    )
    click('Make Price wider')
    expect(apply).toHaveBeenCalledWith(
      [{ op: 'update_placement', at: { field: 'price', group_key: null }, patch: { col_span: 4 } }],
      { label: 'Resize Price' }
    )
  })
})
