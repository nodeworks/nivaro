// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type GroupRow, type LayoutBundle, newGroup, newPlacement } from '../../../lib/layout-ops'
import { type LayoutDesign, LayoutDesignContext } from '../design-context'
import { PdfCanvas } from './PdfCanvas'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function bundle(): LayoutBundle {
  const g1 = { ...newGroup('basics', 'Basics', 'section', null), sort: 0 } as GroupRow
  const g2 = { ...newGroup('money', 'Money', 'section', null), sort: 1 } as GroupRow
  return {
    layout: { id: 7, collection: 'orders', layout_type: 'file' },
    groups: [g1, g2],
    placements: [
      { ...newPlacement('title', 'basics'), sort: 0 },
      { ...newPlacement('amount', 'money'), sort: 0, label_override: 'Total' },
      { ...newPlacement('secret', 'money'), sort: 1, is_visible: false }
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

describe('PdfCanvas', () => {
  it('renders sections and visible fields', () => {
    act(() => root.render(<PdfCanvas bundle={bundle()} collection='orders' />))
    expect(host.textContent).toContain('Basics')
    expect(host.textContent).toContain('Money')
    expect(host.textContent).toContain('Title')
    expect(host.textContent).toContain('Total')
    expect(host.textContent).not.toContain('Secret')
  })

  it('preview link carries layout and record', () => {
    act(() => root.render(<PdfCanvas bundle={bundle()} collection='orders' previewRecordId='42' />))
    const a = host.querySelector('a[data-pdf-preview]') as HTMLAnchorElement
    expect(a.getAttribute('href')).toBe('/api/collection-layouts/7/preview-html?record_id=42')
    expect(a.target).toBe('_blank')
  })

  it('disables preview with a hint when no record', () => {
    act(() => root.render(<PdfCanvas bundle={bundle()} collection='orders' />))
    expect(host.querySelector('a[data-pdf-preview]')).toBeNull()
    const b = host.querySelector('button[data-pdf-preview]') as HTMLButtonElement
    expect(b.disabled).toBe(true)
    expect(host.textContent).toContain('Pick a preview record')
  })

  it('field cells are selectable design nodes', () => {
    const onSelect = vi.fn()
    const design: LayoutDesign = {
      selected: null,
      onSelect,
      showHidden: false,
      inheritedFrom: () => null,
      dnd: { draggableProps: () => ({}), isDragging: () => false, dropSlot: () => null }
    }
    act(() =>
      root.render(
        <LayoutDesignContext.Provider value={design}>
          <PdfCanvas bundle={bundle()} collection='orders' />
        </LayoutDesignContext.Provider>
      )
    )
    const cell = host.querySelector('[data-design-target="field:title:basics"]') as HTMLElement
    act(() => cell.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onSelect).toHaveBeenCalledWith({ kind: 'field', field: 'title', group_key: 'basics' })
    expect(host.querySelector('[data-design-target="group:basics"]')).not.toBeNull()
  })
})
