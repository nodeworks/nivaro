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

  it('preview fetches preview-html with host auth and opens a blob tab', async () => {
    const tab = { location: { href: '' }, close: vi.fn() }
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '<html></html>' })
    vi.stubGlobal('fetch', fetchMock)
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    act(() => root.render(<PdfCanvas bundle={bundle()} collection='orders' />))
    const b = host.querySelector('button[data-pdf-preview]') as HTMLButtonElement
    expect(b.disabled).toBe(false)
    expect(b.textContent).toBe('Preview with sample values')
    await act(async () => b.click())
    expect(fetchMock.mock.calls[0][0]).toBe('/api/collection-layouts/7/preview-html')
    expect(open).toHaveBeenCalledWith('', '_blank')
    expect(tab.location.href).toBe('blob:x')
    vi.unstubAllGlobals()
    open.mockRestore()
  })

  it('preview waits for the last save, then fetches; the tab gets no opener', async () => {
    const tab = { location: { href: '' }, close: vi.fn(), opener: window as unknown }
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '<html></html>' })
    vi.stubGlobal('fetch', fetchMock)
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    let saved!: () => void
    const whenIdle = vi.fn(
      () =>
        new Promise<void>((r) => {
          saved = r
        })
    )
    act(() => root.render(<PdfCanvas bundle={bundle()} collection='orders' whenIdle={whenIdle} />))
    const b = host.querySelector('button[data-pdf-preview]') as HTMLButtonElement
    await act(async () => b.click())
    expect(whenIdle).toHaveBeenCalledTimes(1)
    expect(tab.opener).toBe(null)
    expect(fetchMock).not.toHaveBeenCalled()
    await act(async () => saved())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(tab.location.href).toBe('blob:x')
    vi.unstubAllGlobals()
    open.mockRestore()
  })

  it('labels cells as the PDF prints them: override, then the field label', () => {
    const b = bundle()
    b.placements.push({ ...newPlacement('due', 'basics'), sort: 1 })
    b.placements.push({
      ...newPlacement('ref_no', 'basics'),
      sort: 2,
      overrides: JSON.stringify({ label: 'Reference' })
    })
    act(() =>
      root.render(
        <PdfCanvas
          bundle={b}
          collection='orders'
          fields={[
            { field: 'due', label: 'Due date' },
            { field: 'amount', label: 'Amount (USD)' }
          ]}
        />
      )
    )
    const text = host.textContent ?? ''
    expect(text).toContain('Due date')
    expect(text).toContain('Reference')
    // label_override still wins over the field's label.
    expect(text).toContain('Total')
    expect(text).not.toContain('Amount (USD)')
    // No label anywhere: the key in words.
    expect(text).toContain('Title')
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
