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
import { DesignDropBody, DesignNode } from '../DesignNode'
import { type DesignTarget, type LayoutDesign, LayoutDesignContext } from '../design-context'
import { designClone, LayoutDndProvider, NO_DND, useLayoutDnd } from './LayoutDndProvider'
import { useAddDragSource } from './node'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const bundle: LayoutBundle = {
  layout: { id: 1, collection: 'orders' },
  rev: 'r',
  groups: [
    { ...newGroup('g1', 'Details', 'section', null), sort: 0 },
    { ...newGroup('g2', 'Money', 'section', null), sort: 1 },
    { ...newGroup('g3', 'Notes', 'section', null), sort: 2 },
    ungroupedGroup(3)
  ] as GroupRow[],
  placements: [
    { ...newPlacement('a', 'g1'), sort: 0 },
    { ...newPlacement('b', 'g1'), sort: 1 },
    { ...newPlacement('d', 'g2'), sort: 0 },
    { ...newPlacement('e', 'g2'), sort: 1 },
    { ...newPlacement('__owners__', 'g2'), sort: 2 },
    { ...newPlacement('u1', null), sort: 0 },
    { ...newPlacement('status', '__header__'), sort: 0 },
    { ...newPlacement('amount', '__header__'), sort: 1 }
  ]
}

// Live layout: header tiles status | amount (folded) above; g1 0-200 (header
// 40) with a, b stacked; g2 220-420 (header 40) with d, e, owners stacked; the
// empty g3's pane 440-560 (not a DesignNode, like a tab pane); the Ungrouped
// card 580-680 with u1.
const RECTS: Record<string, [number, number, number, number]> = {
  'header:status': [0, -60, 120, 50],
  'header:amount': [130, -60, 120, 50],
  'group:g1': [0, 0, 600, 200],
  'field:a:g1': [20, 50, 560, 40],
  'field:b:g1': [20, 100, 560, 40],
  'group:g2': [0, 220, 600, 200],
  'field:d:g2': [20, 270, 560, 40],
  'field:e:g2': [20, 320, 560, 40],
  'slot:__owners__:g2': [20, 370, 560, 40],
  'pane:g3': [0, 440, 600, 120],
  'group:__ungrouped__': [0, 580, 600, 100],
  'field:u1:': [20, 600, 560, 40],
  'top:g1': [0, 0, 600, 40],
  'top:g2': [0, 220, 600, 40],
  'add:vendor': [700, 0, 200, 30]
}
/** An Add panel row (outside the canvas) that drags `vendor` in. */
function AddRow({ onAdded, onClick }: { onAdded?: (ops: unknown) => void; onClick?: () => void }) {
  const drag = useAddDragSource({ field: 'vendor', label: 'Vendor', to: 'form', onAdded })
  return (
    <button
      type='button'
      data-rect='add:vendor'
      {...drag.props}
      onClick={() => {
        if (!drag.clickBlocked()) onClick?.()
      }}
    >
      Vendor
    </button>
  )
}

const domRect = ([x, y, w, h]: [number, number, number, number]) =>
  ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h }) as DOMRect

const field = (f: string, g: string): DesignTarget => ({ kind: 'field', field: f, group_key: g })

function Canvas({
  blockPointer,
  dndOff,
  steps
}: {
  blockPointer?: boolean
  dndOff?: boolean
  /** Steps mode: Ungrouped fields sit in the General step's pane; no Ungrouped card. */
  steps?: boolean
}) {
  const dnd = useLayoutDnd()
  const design: LayoutDesign = {
    selected: null,
    onSelect: () => {},
    showHidden: false,
    inheritedFrom: () => null,
    dnd: dndOff ? NO_DND : dnd
  }
  const cell = (t: DesignTarget, label: string) => (
    <DesignNode key={label} target={t}>
      <div>
        <span data-header-label=''>{label}</span>
      </div>
    </DesignNode>
  )
  const section = (key: string, fields: string[]) => (
    <DesignNode target={{ kind: 'group', key }}>
      <div>
        <button type='button' data-design-group-header='' data-rect={`top:${key}`}>
          {key}
        </button>
        {fields.map((f) =>
          f.startsWith('__')
            ? cell({ kind: 'slot', field: f, group_key: key }, 'Owners')
            : cell(field(f, key), `Field ${f.toUpperCase()}`)
        )}
      </div>
    </DesignNode>
  )
  return (
    <LayoutDesignContext.Provider value={design}>
      {/* Like DesignCanvas: pointerdown is cancelled in the capture phase. */}
      <div onPointerDownCapture={blockPointer ? (e) => e.preventDefault() : undefined}>
        {cell({ kind: 'header', field: 'status' }, 'Status')}
        <DesignNode target={{ kind: 'header', field: 'amount' }} data-header-folded=''>
          <div>Amount</div>
        </DesignNode>
        {section('g1', ['a', 'b'])}
        {section('g2', ['d', 'e', '__owners__'])}
        <div data-rect='pane:g3'>
          <DesignDropBody groupKey='g3' />
        </div>
        {steps ? (
          <div data-rect='group:__ungrouped__'>
            <DesignDropBody groupKey='__ungrouped__' />
            {cell({ kind: 'field', field: 'u1', group_key: null }, 'Field U1')}
          </div>
        ) : (
          <DesignNode target={{ kind: 'group', key: '__ungrouped__' }}>
            <div>{cell({ kind: 'field', field: 'u1', group_key: null }, 'Field U1')}</div>
          </DesignNode>
        )}
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

function render(
  apply: (...a: unknown[]) => void,
  children: ReactNode = <Canvas />,
  b: LayoutBundle = bundle
) {
  act(() =>
    root.render(
      <LayoutDndProvider bundle={b} apply={apply}>
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
    pointer('pointerdown', host.querySelector('[data-rect="top:g2"]') as Element, 300, 230)
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

  // Pointer drag of `from` (grabbed at its centre) to (x, y); returns what
  // shows before the drop.
  async function dragTo(from: HTMLElement, x: number, y: number) {
    const k = from.getAttribute('data-design-target') ?? ''
    const [l, t, w, h] = RECTS[k]
    pointer('pointerdown', from.firstElementChild ?? from, l + w / 2, t + h / 2)
    pointer('pointermove', document, l + w / 2, t + h / 2 + 6)
    await tick()
    pointer('pointermove', document, x, y)
    await tick()
  }
  const drop = async (x: number, y: number) => {
    pointer('pointerup', document, x, y)
    await tick()
  }

  it('an empty pane (tab, step, container tab) takes a dropped field', async () => {
    const apply = vi.fn()
    render(apply, <Canvas blockPointer />)
    await dragTo(node('field:a:g1'), 300, 500)
    const body = host.querySelector('[data-design-drop-body="g3"]') as HTMLElement
    expect(body.getAttribute('data-design-drop-indicator')).toBe('after')
    expect(body.hidden).toBe(false)
    await drop(300, 500)
    expect(apply).toHaveBeenCalledWith(
      [{ op: 'move', from: { field: 'a', group_key: 'g1' }, to_group_key: 'g3', index: 0 }],
      { label: 'Move field' }
    )
    expect(body.hidden).toBe(true)
  })

  it('an owners slot leaving a section shows and lands beside the Ungrouped card', async () => {
    const apply = vi.fn()
    render(apply, <Canvas blockPointer />)
    await dragTo(node('slot:__owners__:g2'), 300, 630)
    expect(node('field:u1:').hasAttribute('data-drop-slot')).toBe(false)
    expect(node('group:__ungrouped__').getAttribute('data-drop-slot')).toBe('after')
    await drop(300, 630)
    // Canvas order g1, g2, g3, Ungrouped: below the Ungrouped card = 4.
    expect(apply).toHaveBeenCalledWith(
      [
        { op: 'move', from: { field: '__owners__', group_key: 'g2' }, to_group_key: null, index: 4 }
      ],
      { label: 'Move field' }
    )
  })

  it('shows no line, and drops nothing, where a drop would change nothing', async () => {
    const apply = vi.fn()
    const twin = {
      ...bundle,
      placements: [...bundle.placements, { ...newPlacement('a', 'g2'), sort: 3 }]
    }
    render(apply, <Canvas blockPointer />, twin)
    await dragTo(node('field:a:g1'), 300, 290)
    expect(host.querySelector('[data-drop-slot]')).toBeNull()
    expect(host.querySelector('[data-design-drop-indicator]:not([hidden])')).toBeNull()
    await drop(300, 290)
    expect(apply).not.toHaveBeenCalled()
  })

  it('space on a button inside a section does not pick the section up', async () => {
    const apply = vi.fn()
    render(apply)
    const g1 = node('group:g1')
    const headerButton = host.querySelector('[data-rect="top:g1"]') as HTMLElement
    headerButton.focus()
    key('Space', headerButton)
    await tick()
    expect(g1.className).not.toContain('opacity-40')
    g1.focus()
    key('Space', g1)
    await tick()
    expect(g1.className).toContain('opacity-40')
    key('Escape')
    await tick()
  })

  it('a canvas may gain or lose drag and drop without breaking', async () => {
    const apply = vi.fn()
    render(apply)
    expect(node('field:a:g1').getAttribute('aria-roledescription')).toBe('draggable')
    // NO_DND inside a provider turns dragging off.
    render(apply, <Canvas dndOff blockPointer />)
    expect(node('field:a:g1').hasAttribute('aria-roledescription')).toBe(false)
    await dragTo(node('field:a:g1'), 300, 290)
    expect(host.querySelector('[data-drop-slot]')).toBeNull()
    expect(document.body.querySelector('[data-design-drag-preview]')).toBeNull()
    await drop(300, 290)
    expect(apply).not.toHaveBeenCalled()
    // No provider at all.
    act(() => root.render(<Canvas />))
    expect(node('field:a:g1').hasAttribute('aria-roledescription')).toBe(false)
    render(apply)
    expect(node('field:a:g1').getAttribute('aria-roledescription')).toBe('draggable')
  })

  it('steps mode: a slot over Ungrouped fields has no card to land by, so no line and no drop', async () => {
    const apply = vi.fn()
    render(apply, <Canvas blockPointer steps />)
    await dragTo(node('slot:__owners__:g2'), 300, 630)
    expect(host.querySelector('[data-drop-slot]')).toBeNull()
    expect(host.querySelector('[data-design-drop-indicator]:not([hidden])')).toBeNull()
    await drop(300, 630)
    expect(apply).not.toHaveBeenCalled()
    // A plain field still drops into the General step's Ungrouped fields.
    await dragTo(node('field:a:g1'), 300, 630)
    expect(node('field:u1:').getAttribute('data-drop-slot')).toBe('after')
    await drop(300, 630)
    expect(apply).toHaveBeenCalledWith(
      [{ op: 'move', from: { field: 'a', group_key: 'g1' }, to_group_key: null, index: 1 }],
      { label: 'Move field' }
    )
  })

  it('a folded header tile is not a drop target', async () => {
    const apply = vi.fn()
    render(apply, <Canvas blockPointer />)
    const status = node('header:status')
    expect(status.getAttribute('aria-roledescription')).toBe('draggable')
    await dragTo(status, 190, -40)
    expect(node('header:amount').hasAttribute('data-drop-slot')).toBe(false)
    await drop(190, -40)
    expect(apply).not.toHaveBeenCalled()
  })

  it('an Add panel row dragged onto the form emits one place op', async () => {
    const apply = vi.fn()
    const onAdded = vi.fn()
    const onClick = vi.fn()
    render(
      apply,
      <>
        <AddRow onAdded={onAdded} onClick={onClick} />
        <Canvas blockPointer />
      </>
    )
    const row = host.querySelector('[data-rect="add:vendor"]') as HTMLElement
    expect(row.getAttribute('aria-roledescription')).toBe('draggable')
    pointer('pointerdown', row, 750, 15)
    pointer('pointermove', document, 740, 20)
    await tick()
    // The preview is a copy of the row.
    expect(document.body.querySelector('[data-design-drag-preview]')?.textContent).toBe('Vendor')
    // Lower half of field a: after it.
    pointer('pointermove', document, 100, 80)
    await tick()
    expect(node('field:a:g1').getAttribute('data-drop-slot')).toBe('after')
    pointer('pointerup', document, 100, 80)
    await tick()
    const ops = [{ op: 'place', field: 'vendor', group_key: 'g1', index: 1 }]
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith(ops, { label: 'Add Vendor' })
    expect(onAdded).toHaveBeenCalledWith(ops)
    // The click that ends the drag adds nothing more.
    act(() => row.click())
    expect(onClick).not.toHaveBeenCalled()
  })

  it('an Add panel row is a plain button outside a provider', () => {
    act(() => root.render(<AddRow />))
    const row = host.querySelector('[data-rect="add:vendor"]') as HTMLElement
    expect(row.hasAttribute('aria-roledescription')).toBe(false)
  })
})

describe('designClone', () => {
  it('copies a step as a plain card: no dragging dim, no chevron shape', () => {
    const step = document.createElement('div')
    step.className = 'relative opacity-40 flex-1'
    step.style.clipPath = 'polygon(0 0, 90% 0, 100% 50%, 90% 100%, 0 100%)'
    step.style.transform = 'translateZ(0)'
    const inner = document.createElement('button')
    inner.style.clipPath = 'polygon(0 0, 100% 0, 100% 100%, 0 100%)'
    step.append(inner)
    const copy = designClone(step)
    expect(copy.classList.contains('opacity-40')).toBe(false)
    expect(copy.style.clipPath).toBe('none')
    expect((copy.firstChild as HTMLElement).style.clipPath).toBe('none')
    expect(copy.style.height).toBe('100%')
  })
})
