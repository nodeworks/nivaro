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

  it('marks what a previewed role cannot see (faint, tagged) or change (lock tag)', () => {
    const marks: Record<string, 'hidden' | 'readonly'> = { title: 'hidden', amount: 'readonly' }
    const d = design({
      roleMark: (t) =>
        t.kind === 'field' && marks[t.field] ? { kind: marks[t.field], role: 'Finance' } : null
    })
    const amount: DesignTarget = { kind: 'field', field: 'amount', group_key: null }
    const notes: DesignTarget = { kind: 'field', field: 'notes', group_key: null }
    act(() =>
      root.render(
        <LayoutDesignContext.Provider value={d}>
          <DesignNode target={target}>
            <span>t</span>
          </DesignNode>
          <DesignNode target={amount}>
            <span>a</span>
          </DesignNode>
          <DesignNode target={notes}>
            <span>n</span>
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    const at = (k: string) => host.querySelector(`[data-design-target="${k}"]`) as HTMLElement
    const tag = (k: string) => at(k).querySelector('[data-design-role-tag]')
    expect(at('field:title:').getAttribute('data-role-mark')).toBe('hidden')
    expect(at('field:title:').className).toContain('opacity-40')
    expect(tag('field:title:')?.textContent).toBe('Hidden for Finance')
    expect(at('field:amount:').getAttribute('data-role-mark')).toBe('readonly')
    expect(at('field:amount:').className).not.toContain('opacity-40')
    expect(tag('field:amount:')?.textContent).toBe('Read-only for Finance')
    expect(at('field:notes:').hasAttribute('data-role-mark')).toBe(false)
    expect(tag('field:notes:')).toBeNull()
    // Still selectable.
    act(() => at('field:title:').click())
    expect(d.onSelect).toHaveBeenCalledWith(target)
  })

  it('shows the drop line without changing the node size', () => {
    const d = design({
      dnd: {
        draggableProps: () => ({}),
        isDragging: () => false,
        dropSlot: () => 'before',
        dropIndicator: () => ({ top: -6, left: 0, width: 120, height: 3 })
      }
    })
    act(() =>
      root.render(
        <LayoutDesignContext.Provider value={d}>
          <DesignNode target={target} asChild>
            <div style={{ gridColumn: 'span 6' }}>cell</div>
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    const node = host.querySelector('[data-design-target]') as HTMLElement
    expect(node.className).not.toMatch(/border-[tb]-2/)
    expect(node.style.gridColumn).toBe('span 6')
    const line = node.querySelector('[data-design-drop-indicator]') as HTMLElement
    expect(line.getAttribute('data-design-drop-indicator')).toBe('before')
    expect(line.className).toContain('absolute')
    expect(line.style.width).toBe('120px')
  })

  it("keeps the child's and the dnd handlers, classes and refs", () => {
    const childClick = vi.fn()
    const childRef = vi.fn()
    const dndKey = vi.fn()
    const dndRef = vi.fn()
    const d = design({
      dnd: {
        draggableProps: () => ({ ref: dndRef, onKeyDown: dndKey, tabIndex: 0 }),
        isDragging: () => false,
        dropSlot: () => null
      }
    })
    act(() =>
      root.render(
        <LayoutDesignContext.Provider value={d}>
          <DesignNode target={target} asChild pass>
            <button type='button' className='own' ref={childRef} onClick={childClick}>
              tab
            </button>
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    const node = host.querySelector('[data-design-target]') as HTMLElement
    expect(node.className).toContain('own')
    expect(node.className).toContain('cursor-pointer')
    expect(childRef).toHaveBeenCalledWith(node)
    expect(dndRef).toHaveBeenCalledWith(node)
    act(() => node.click())
    expect(d.onSelect).toHaveBeenCalledWith(target)
    expect(childClick).toHaveBeenCalled()
    act(() => {
      node.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    })
    expect(dndKey).toHaveBeenCalled()
  })

  it('registers a folded header copy as not draggable', () => {
    const draggableProps = vi.fn((_t: DesignTarget, o?: { disabled?: boolean }) =>
      o?.disabled ? {} : { 'data-draggable': 'yes' }
    )
    const d = design({ dnd: { draggableProps, isDragging: () => false, dropSlot: () => 'after' } })
    const tile: DesignTarget = { kind: 'header', field: 'amount' }
    act(() =>
      root.render(
        <LayoutDesignContext.Provider value={d}>
          <DesignNode target={tile}>
            <span>row</span>
          </DesignNode>
          <DesignNode target={tile} data-design-copy=''>
            <span>copy</span>
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    const [row, copy] = Array.from(host.querySelectorAll('[data-design-target]'))
    expect(row.getAttribute('data-draggable')).toBe('yes')
    expect(copy.hasAttribute('data-draggable')).toBe(false)
    expect(copy.querySelector('[data-design-drop-indicator]')).toBeNull()
    expect(draggableProps).toHaveBeenCalledWith(tile, { disabled: true })
  })
})
