// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesignNode } from './DesignNode'
import { type DesignTarget, type LayoutDesign, LayoutDesignContext } from './design-context'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const target: DesignTarget = { kind: 'field', field: 'title', group_key: null }

function design(over: Partial<LayoutDesign> = {}): LayoutDesign {
  return {
    selected: null,
    onSelect: vi.fn(),
    showHidden: false,
    inheritedFrom: () => null,
    dnd: {
      draggableProps: () => ({ 'data-draggable': 'yes' }),
      isDragging: () => false,
      dropSlot: () => null
    },
    ...over
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

describe('DesignNode', () => {
  it('renders children untouched when no design context', () => {
    act(() =>
      root.render(
        <DesignNode target={target}>
          <span id='c'>hi</span>
        </DesignNode>
      )
    )
    expect(host.innerHTML).toBe('<span id="c">hi</span>')
  })

  it('adds data-design-target, selection outline and click-to-select inside a context', () => {
    const d = design({ selected: target })
    act(() =>
      root.render(
        <LayoutDesignContext.Provider value={d}>
          <DesignNode target={target}>
            <span id='c'>hi</span>
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    const node = host.querySelector('[data-design-target]') as HTMLElement
    expect(node.getAttribute('data-design-target')).toBe('field:title:')
    expect(node.getAttribute('data-selected')).toBe('true')
    expect(node.className).toContain('outline')
    act(() => node.click())
    expect(d.onSelect).toHaveBeenCalledWith(target)
  })

  it('marks inherited nodes and blocks drag', () => {
    const d = design({ inheritedFrom: () => 'Base form' })
    act(() =>
      root.render(
        <LayoutDesignContext.Provider value={d}>
          <DesignNode target={target}>
            <span>hi</span>
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    const node = host.querySelector('[data-design-target]') as HTMLElement
    expect(node.hasAttribute('data-draggable')).toBe(false)
    expect(node.textContent).toContain('from Base form')
  })
})
