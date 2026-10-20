// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type GroupRow,
  type LayoutBundle,
  newGroup,
  newPlacement,
  ungroupedGroup
} from '../../../lib/layout-ops'
import { DesignNode } from '../DesignNode'
import { type DesignTarget, type LayoutDesign, LayoutDesignContext } from '../design-context'
import { LayoutDndProvider, useLayoutDnd } from './LayoutDndProvider'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const bundle: LayoutBundle = {
  layout: { id: 1, collection: 'orders' },
  rev: 'r',
  groups: [
    { ...newGroup('g1', 'Details', 'section', null), sort: 0 },
    { ...newGroup('g2', 'Money', 'section', null), sort: 1 },
    ungroupedGroup(2)
  ] as GroupRow[],
  placements: [
    { ...newPlacement('a', 'g1'), sort: 0 },
    { ...newPlacement('b', 'g1'), sort: 1 },
    { ...newPlacement('d', 'g2'), sort: 0 },
    { ...newPlacement('e', 'g2'), sort: 1 }
  ]
}

// Live layout: g1 0-200 (header 40) with a, b stacked; g2 220-420 (header 40)
// with d, e stacked.
const RECTS: Record<string, [number, number, number, number]> = {
  'group:g1': [0, 0, 600, 200],
  'field:a:g1': [20, 50, 560, 40],
  'field:b:g1': [20, 100, 560, 40],
  'group:g2': [0, 220, 600, 200],
  'field:d:g2': [20, 270, 560, 40],
  'field:e:g2': [20, 320, 560, 40],
  'header:g1': [0, 0, 600, 40],
  'header:g2': [0, 220, 600, 40]
}
const domRect = ([x, y, w, h]: [number, number, number, number]) =>
  ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h }) as DOMRect

const field = (f: string, g: string): DesignTarget => ({ kind: 'field', field: f, group_key: g })

function Canvas({ blockPointer }: { blockPointer?: boolean }) {
  const dnd = useLayoutDnd()
  const design: LayoutDesign = {
    selected: null,
    onSelect: () => {},
    showHidden: false,
    inheritedFrom: () => null,
    dnd
  }
  const section = (key: string, fields: string[]) => (
    <DesignNode target={{ kind: 'group', key }}>
      <div>
        <div data-design-group-header='' data-rect={`header:${key}`}>
          {key}
        </div>
        {fields.map((f) => (
          <DesignNode key={f} target={field(f, key)}>
            <div>
              <span data-header-label=''>Field {f.toUpperCase()}</span>
            </div>
          </DesignNode>
        ))}
      </div>
    </DesignNode>
  )
  return (
    <LayoutDesignContext.Provider value={design}>
      {/* Like DesignCanvas: pointerdown is cancelled in the capture phase. */}
      <div onPointerDownCapture={blockPointer ? (e) => e.preventDefault() : undefined}>
        {section('g1', ['a', 'b'])}
        {section('g2', ['d', 'e'])}
      </div>
    </LayoutDesignContext.Provider>
  )
}

let host: HTMLDivElement
let root: Root
const original = Element.prototype.getBoundingClientRect
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const k = this.getAttribute('data-design-target') ?? this.getAttribute('data-rect')
    return domRect(RECTS[k ?? ''] ?? [0, 0, 0, 0])
  }
  Element.prototype.scrollIntoView = () => {}
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  Element.prototype.getBoundingClientRect = original
})

const tick = () => act(() => new Promise((r) => setTimeout(r, 0)))
const node = (key: string) => host.querySelector(`[data-design-target="${key}"]`) as HTMLElement
const key = (code: string, target: EventTarget = document) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }))
  })

function render(apply: (...a: unknown[]) => void, children: ReactNode = <Canvas />) {
  act(() =>
    root.render(
      <LayoutDndProvider bundle={bundle} apply={apply}>
        {children}
      </LayoutDndProvider>
    )
  )
}

function pointer(type: string, target: EventTarget, x: number, y: number) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })
  Object.defineProperty(e, 'isPrimary', { value: true })
  act(() => {
    target.dispatchEvent(e)
  })
}

describe('LayoutDndProvider', () => {
  it('a keyboard drag across groups emits one op batch', async () => {
    const apply = vi.fn()
    render(apply)
    const a = node('field:a:g1')
    expect(a.getAttribute('aria-roledescription')).toBe('draggable')
    a.focus()
    key('Space', a)
    await tick()
    expect(a.className).toContain('opacity-40')
    // a → after b → after d (into the other section)
    key('ArrowDown')
    await tick()
    key('ArrowDown')
    await tick()
    expect(node('field:d:g2').getAttribute('data-drop-slot')).toBe('after')
    expect(node('field:d:g2').querySelector('[data-design-drop-indicator]')).not.toBeNull()
    key('Space')
    await tick()
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith(
      [{ op: 'move', from: { field: 'a', group_key: 'g1' }, to_group_key: 'g2', index: 1 }],
      { label: 'Move field' }
    )
    expect(host.querySelector('[data-drop-slot]')).toBeNull()
    expect(a.className).not.toContain('opacity-40')
  })

  it('escape cancels without any op', async () => {
    const apply = vi.fn()
    render(apply)
    const a = node('field:a:g1')
    a.focus()
    key('Space', a)
    await tick()
    key('ArrowDown')
    await tick()
    key('Escape')
    await tick()
    expect(apply).not.toHaveBeenCalled()
  })

  it('a pointer drag works through a canvas that cancels pointerdown', async () => {
    const apply = vi.fn()
    render(apply, <Canvas blockPointer />)
    const b = node('field:b:g1')
    pointer('pointerdown', b.querySelector('[data-header-label]') as Element, 100, 120)
    pointer('pointermove', document, 100, 140)
    await tick()
    // The preview is a copy of the field as it looks, outside the canvas.
    const preview = document.body.querySelector('[data-design-drag-preview]')
    expect(preview?.textContent).toBe('Field B')
    expect(preview?.querySelector('[data-design-target]')).toBeNull()
    // Over the second section's header: first in that section.
    pointer('pointermove', document, 300, 230)
    await tick()
    expect(node('group:g2').getAttribute('data-drop-slot')).toBe('before')
    pointer('pointerup', document, 300, 230)
    await tick()
    expect(apply).toHaveBeenCalledWith(
      [{ op: 'move', from: { field: 'b', group_key: 'g1' }, to_group_key: 'g2', index: 0 }],
      { label: 'Move field' }
    )
  })

  it('a section dropped over another section reorders the sections', async () => {
    const apply = vi.fn()
    render(apply, <Canvas blockPointer />)
    // Grab the section by its header, drop it over the other section's fields.
    pointer('pointerdown', host.querySelector('[data-rect="header:g2"]') as Element, 300, 230)
    pointer('pointermove', document, 300, 240)
    await tick()
    pointer('pointermove', document, 300, 60)
    await tick()
    expect(node('group:g1').getAttribute('data-drop-slot')).toBe('before')
    expect(node('field:a:g1').hasAttribute('data-drop-slot')).toBe(false)
    pointer('pointerup', document, 300, 60)
    await tick()
    expect(apply).toHaveBeenCalledWith(
      [{ op: 'group_move', key: 'g2', parent_key: null, index: 0 }],
      { label: 'Move section "Money"' }
    )
  })
})
