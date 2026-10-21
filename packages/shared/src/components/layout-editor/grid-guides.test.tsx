// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type LayoutDesign, LayoutDesignContext } from './design-context'
import { DndStore, DndStoreContext } from './dnd/node'
import { GridGuides, snapSpan } from './grid-guides'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// #2701: column guides while dragging or resizing, and the width handle's snap.

const design: LayoutDesign = {
  selected: null,
  onSelect: vi.fn(),
  showHidden: false,
  inheritedFrom: () => null,
  dnd: { draggableProps: () => ({}), isDragging: () => false, dropSlot: () => null }
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

describe('GridGuides', () => {
  it('shows twelve tracks only while something drags or a width is dragged', () => {
    const store = new DndStore()
    act(() =>
      root.render(
        <DndStoreContext.Provider value={store}>
          <LayoutDesignContext.Provider value={design}>
            <GridGuides />
          </LayoutDesignContext.Provider>
        </DndStoreContext.Provider>
      )
    )
    const guides = () => host.querySelector('[data-design-grid-guides]')
    expect(guides()).toBeNull()
    act(() => store.set({ activeKey: 'field:a:main' }))
    expect(guides()?.children).toHaveLength(12)
    act(() => store.set({ activeKey: null }))
    expect(guides()).toBeNull()
    act(() => store.setResizing(true))
    expect(guides()).not.toBeNull()
    act(() => store.setResizing(false))
    expect(guides()).toBeNull()
  })

  it('never shows on a record page', () => {
    const store = new DndStore()
    store.setResizing(true)
    act(() =>
      root.render(
        <DndStoreContext.Provider value={store}>
          <GridGuides />
        </DndStoreContext.Provider>
      )
    )
    expect(host.innerHTML).toBe('')
  })
})

describe('snapSpan', () => {
  // A 1176px grid with 16px gaps: 12 columns of 83px.
  const W = 1176
  const GAP = 16
  const px = (cols: number) => cols * 83 + (cols - 1) * GAP
  it('snaps to the widths the form takes', () => {
    expect(snapSpan(px(12), W, GAP)).toBe(12)
    expect(snapSpan(px(6) + 30, W, GAP)).toBe(6)
    expect(snapSpan(px(4) - 20, W, GAP)).toBe(4)
    expect(snapSpan(px(3), W, GAP)).toBe(3)
    expect(snapSpan(10, W, GAP)).toBe(3)
    expect(snapSpan(px(10), W, GAP)).toBe(12)
    expect(snapSpan(px(8), W, GAP)).toBe(6)
  })
  it('falls back to full width when the grid has no room', () => {
    expect(snapSpan(100, 0, GAP)).toBe(12)
  })
})
