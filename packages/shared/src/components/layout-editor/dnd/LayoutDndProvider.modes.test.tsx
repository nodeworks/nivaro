// @vitest-environment jsdom
import { act } from 'react'
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
import { PIN_KEY } from '../pin'
import { mergePlan } from '../section-structure'
import { LayoutDndProvider, useLayoutDnd } from './LayoutDndProvider'
import type { TrashWarning } from './trash-links'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// #3178 selection drag, #3199 Alt copies, #3198 join by drop, #3203 pinned
// field, #3190 trash links, #3204 undo chip, #3193 touch.

const base: LayoutBundle = {
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

// g1 0-200 (header 40) with a, b; g2 220-420 (header 40) with d, e; the trash at the bottom.
const RECTS: Record<string, [number, number, number, number]> = {
  'group:g1': [0, 0, 600, 200],
  'top:g1': [0, 0, 600, 40],
  'field:a:g1': [20, 50, 560, 40],
  'field:b:g1': [20, 100, 560, 40],
  'group:g2': [0, 220, 600, 200],
  'top:g2': [0, 220, 600, 40],
  'field:d:g2': [20, 270, 560, 40],
  'field:e:g2': [20, 320, 560, 40],
  trash: [150, 700, 300, 60]
}
const domRect = ([x, y, w, h]: [number, number, number, number]) =>
  ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h }) as DOMRect
const field = (f: string, g: string): DesignTarget => ({ kind: 'field', field: f, group_key: g })

function Canvas() {
  const dnd = useLayoutDnd()
  const design: LayoutDesign = {
    selected: null,
    onSelect: () => {},
    showHidden: false,
    inheritedFrom: () => null,
    dnd
  }
  const cell = (f: string, g: string) => (
    <DesignNode key={f} target={field(f, g)}>
      <div>
        <span data-header-label=''>Field {f.toUpperCase()}</span>
      </div>
    </DesignNode>
  )
  const section = (key: string, fields: string[]) => (
    <DesignNode target={{ kind: 'group', key }}>
      <div>
        <button type='button' data-design-group-header='' data-rect={`top:${key}`}>
          {key}
        </button>
        {fields.map((f) => cell(f, key))}
      </div>
    </DesignNode>
  )
  return (
    <LayoutDesignContext.Provider value={design}>
      <div onPointerDownCapture={(e) => e.preventDefault()}>
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
    const k =
      this.getAttribute('data-design-target') ??
      this.getAttribute('data-rect') ??
      (this.hasAttribute('data-layout-trash') ? 'trash' : '')
    return domRect(RECTS[k] ?? [0, 0, 0, 0])
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

type Props = Partial<Parameters<typeof LayoutDndProvider>[0]>
function render(apply: (...a: unknown[]) => void, props: Props = {}, b: LayoutBundle = base) {
  act(() =>
    root.render(
      <LayoutDndProvider bundle={b} apply={apply} {...props}>
        <Canvas />
      </LayoutDndProvider>
    )
  )
}

function pointer(
  type: string,
  target: EventTarget,
  x: number,
  y: number,
  init: MouseEventInit & { pointerType?: string } = {}
) {
  const e = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    ...init
  })
  Object.defineProperty(e, 'isPrimary', { value: true })
  if (init.pointerType) Object.defineProperty(e, 'pointerType', { value: init.pointerType })
  act(() => {
    target.dispatchEvent(e)
  })
}
async function dragTo(from: Element, start: [number, number], x: number, y: number, alt = false) {
  pointer('pointerdown', from, start[0], start[1], { altKey: alt })
  pointer('pointermove', document, start[0], start[1] + 6, { altKey: alt })
  await tick()
  pointer('pointermove', document, x, y, { altKey: alt })
  await tick()
}
const drop = async (x: number, y: number, alt = false) => {
  pointer('pointerup', document, x, y, { altKey: alt })
  await tick()
}
const label = (f: string) => node(`field:${f}:g1`).querySelector('[data-header-label]') as Element

describe('selection drag (#3178)', () => {
  it('a drag on one of the selected fields moves them all, in order, as one step', async () => {
    const apply = vi.fn()
    render(apply, { selection: [field('b', 'g1'), field('a', 'g1')] })
    await dragTo(label('a'), [300, 70], 300, 300)
    // Both dim; the preview counts them.
    expect(node('field:a:g1').className).toContain('opacity-40')
    expect(node('field:b:g1').className).toContain('opacity-40')
    expect(document.body.querySelector('[data-design-drag-badge="count"]')?.textContent).toBe('2')
    expect(node('field:d:g2').getAttribute('data-drop-slot')).toBe('after')
    await drop(300, 300)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith(
      [
        { op: 'move', from: { field: 'a', group_key: 'g1' }, to_group_key: 'g2', index: 1 },
        { op: 'move', from: { field: 'b', group_key: 'g1' }, to_group_key: 'g2', index: 2 }
      ],
      { label: 'Move 2 fields' }
    )
  })

  it('a field outside the selection drags alone', async () => {
    const apply = vi.fn()
    render(apply, { selection: [field('a', 'g1'), field('b', 'g1')] })
    await dragTo(node('field:d:g2').firstElementChild as Element, [300, 290], 300, 70)
    expect(node('field:a:g1').className).not.toContain('opacity-40')
    await drop(300, 70)
    expect(apply).toHaveBeenCalledWith(
      [{ op: 'move', from: { field: 'd', group_key: 'g2' }, to_group_key: 'g1', index: 1 }],
      { label: 'Move field' }
    )
  })
})

describe('Alt-drag copies (#3199)', () => {
  it('Alt held from the start: the field is placed again where it lands', async () => {
    const apply = vi.fn()
    render(apply)
    await dragTo(label('a'), [300, 70], 300, 300, true)
    expect(document.body.querySelector('[data-design-drag-badge="copy"]')).not.toBeNull()
    expect(document.body.querySelector('[data-design-drag-preview][data-copy]')).not.toBeNull()
    await drop(300, 300, true)
    expect(apply).toHaveBeenCalledTimes(1)
    const [ops, opts] = apply.mock.calls[0] as [Array<Record<string, unknown>>, { label: string }]
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ op: 'place', field: 'a', group_key: 'g2', index: 1 })
    expect(opts.label).toBe('Copy Field A')
  })

  it('Alt pressed mid-drag switches to a copy; released, back to a move', async () => {
    const apply = vi.fn()
    render(apply)
    await dragTo(label('a'), [300, 70], 300, 300)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', altKey: true }))
    })
    await tick()
    expect(document.body.querySelector('[data-design-drag-preview][data-copy]')).not.toBeNull()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }))
    })
    await tick()
    expect(document.body.querySelector('[data-design-drag-preview][data-copy]')).toBeNull()
    await drop(300, 300)
    expect(apply).toHaveBeenCalledWith(
      [{ op: 'move', from: { field: 'a', group_key: 'g1' }, to_group_key: 'g2', index: 1 }],
      { label: 'Move field' }
    )
  })

  it('a copy into the section that already holds the field shows no line', async () => {
    const apply = vi.fn()
    render(apply)
    await dragTo(label('a'), [300, 70], 300, 130, true)
    expect(host.querySelector('[data-drop-slot]')).toBeNull()
    await drop(300, 130, true)
    expect(apply).not.toHaveBeenCalled()
  })
})

describe('drop a section on a section header to join (#3198)', () => {
  it('joins and says so on the header', async () => {
    const apply = vi.fn()
    render(apply)
    const top = host.querySelector('[data-rect="top:g2"]') as Element
    await dragTo(top, [300, 230], 300, 25)
    const ind = node('group:g1').querySelector('[data-design-drop-indicator]')
    expect(ind).not.toBeNull()
    expect(ind?.querySelector('[data-design-merge-label]')?.textContent).toBe('Join into Details')
    await drop(300, 25)
    const plan = mergePlan(base, 'g2', 'g1')
    if (!plan.ok) throw new Error(plan.reason)
    expect(apply).toHaveBeenCalledWith(plan.ops, { label: 'Join Money into Details' })
  })

  it('the header’s top edge still reorders', async () => {
    const apply = vi.fn()
    render(apply)
    await dragTo(host.querySelector('[data-rect="top:g2"]') as Element, [300, 230], 300, 4)
    expect(host.querySelector('[data-design-merge-label]')).toBeNull()
    await drop(300, 4)
    expect(apply).toHaveBeenCalledWith(
      [{ op: 'group_move', key: 'g2', parent_key: null, index: 0 }],
      { label: 'Move section "Money"' }
    )
  })
})

describe('pinned field (#3203)', () => {
  it('does not drag', () => {
    const pinned: LayoutBundle = {
      ...base,
      placements: base.placements.map((p) =>
        p.field === 'a' ? { ...p, overrides: { [PIN_KEY]: true } } : p
      )
    }
    render(vi.fn(), {}, pinned)
    expect(node('field:a:g1').hasAttribute('aria-roledescription')).toBe(false)
    expect(node('field:b:g1').getAttribute('aria-roledescription')).toBe('draggable')
  })
})

describe('the trash (#3190 #3204)', () => {
  const warning: TrashWarning = {
    headline: 'Field A drives 2 rules',
    effects: ['Fills Total', 'Shows or hides Money'],
    count: 2
  }

  it('says what depends on the field, then leaves an Undo chip where it was dropped', async () => {
    const apply = vi.fn()
    const run = vi.fn()
    const warnTrash = vi.fn(() => warning)
    render(apply, { warnTrash, undo: { run, label: null } })
    await dragTo(label('a'), [300, 70], 300, 300)
    expect(warnTrash).toHaveBeenCalledWith(base, [
      { op: 'remove', at: { field: 'a', group_key: 'g1' } }
    ])
    const links = document.body.querySelector('[data-trash-links]')
    expect(links?.textContent).toContain('Field A drives 2 rules')
    // Over the trash: the effects too.
    pointer('pointermove', document, 300, 730)
    await tick()
    pointer('pointermove', document, 302, 731)
    await tick()
    expect(document.body.querySelector('[data-layout-trash]')?.hasAttribute('data-over')).toBe(true)
    expect(document.body.querySelector('[data-trash-links]')?.textContent).toContain(
      'Fills Total · Shows or hides Money'
    )
    await drop(302, 731)
    expect(apply).toHaveBeenCalledWith([{ op: 'remove', at: { field: 'a', group_key: 'g1' } }], {
      label: 'Remove Field A'
    })
    const chip = document.body.querySelector('[data-trash-undo-chip]') as HTMLElement
    expect(chip?.textContent).toContain('Removed Field A')
    // The draft now reports the step; Undo runs the draft's undo.
    render(apply, { warnTrash, undo: { run, label: 'Remove Field A' } })
    act(() => {
      ;(document.body.querySelector('[data-trash-undo]') as HTMLElement).click()
    })
    expect(run).toHaveBeenCalledTimes(1)
    expect(document.body.querySelector('[data-trash-undo-chip]')).toBeNull()
  })

  it('the chip goes once another change is the step Undo would reverse', async () => {
    const apply = vi.fn()
    const run = vi.fn()
    render(apply, { undo: { run, label: null } })
    await dragTo(label('a'), [300, 70], 300, 730)
    pointer('pointermove', document, 302, 731)
    await tick()
    await drop(302, 731)
    render(apply, { undo: { run, label: 'Remove Field A' } })
    expect(document.body.querySelector('[data-trash-undo-chip]')).not.toBeNull()
    render(apply, { undo: { run, label: 'Move field' } })
    await tick()
    expect(document.body.querySelector('[data-trash-undo-chip]')).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })
})

describe('touch (#3193)', () => {
  function touch(type: string, target: EventTarget, x: number, y: number) {
    const e = new Event(type, { bubbles: true, cancelable: true })
    const t = { clientX: x, clientY: y, target }
    Object.defineProperties(e, {
      touches: { value: type === 'touchend' ? [] : [t] },
      changedTouches: { value: [t] },
      clientX: { value: x },
      clientY: { value: y }
    })
    act(() => {
      target.dispatchEvent(e)
    })
  }

  it('a touch pointer does not start a mouse drag', async () => {
    const apply = vi.fn()
    render(apply)
    pointer('pointerdown', label('a'), 300, 70, { pointerType: 'touch' })
    pointer('pointermove', document, 300, 90, { pointerType: 'touch' })
    await tick()
    expect(document.body.querySelector('[data-design-drag-preview]')).toBeNull()
  })

  it('press and hold, then drag, moves the field', async () => {
    const apply = vi.fn()
    render(apply)
    const el = label('a')
    touch('touchstart', el, 300, 70)
    // Still within the hold: nothing picked up yet.
    await tick()
    expect(document.body.querySelector('[data-design-drag-preview]')).toBeNull()
    await act(() => new Promise((r) => setTimeout(r, 300)))
    touch('touchmove', el, 300, 80)
    await tick()
    expect(document.body.querySelector('[data-design-drag-preview]')).not.toBeNull()
    touch('touchmove', el, 300, 300)
    await tick()
    touch('touchend', el, 300, 300)
    await tick()
    expect(apply).toHaveBeenCalledWith(
      [{ op: 'move', from: { field: 'a', group_key: 'g1' }, to_group_key: 'g2', index: 1 }],
      { label: 'Move field' }
    )
  })

  it('a quick swipe scrolls instead (moves before the hold ends)', async () => {
    const apply = vi.fn()
    render(apply)
    const el = label('a')
    touch('touchstart', el, 300, 70)
    touch('touchmove', el, 300, 140)
    await act(() => new Promise((r) => setTimeout(r, 300)))
    expect(document.body.querySelector('[data-design-drag-preview]')).toBeNull()
    touch('touchend', el, 300, 140)
    expect(apply).not.toHaveBeenCalled()
  })
})
