import { describe, expect, it } from 'vitest'
import {
  boxInOverlay,
  describeElement,
  domHookNode,
  frameScale,
  nearestDataField,
  pointInFrame,
  selectorFor
} from './inspector-logic'

/**
 * Element inspector (#1372): the selector built from the live replay DOM must
 * equal the one the server indexed from the snapshot, or "Find in other
 * recordings" finds nothing.
 */

type V = { tag: string; attrs?: Record<string, string>; children?: V[]; target?: boolean }

function build(v: V, parent: Element | null): Element | null {
  const el = document.createElement(v.tag)
  for (const [k, val] of Object.entries(v.attrs ?? {})) el.setAttribute(k, val)
  if (parent) parent.appendChild(el)
  else document.body.appendChild(el)
  let target: Element | null = v.target ? el : null
  for (const c of v.children ?? []) target = build(c, el) ?? target
  return target
}

// KEEP IN STEP with api/src/test/unit/services/session-replay-index.test.ts
const VECTORS: Array<{ tree: V; selector: string; anchored: boolean; field: string | null }> = [
  {
    tree: {
      tag: 'div',
      attrs: { 'data-field': 'due_date' },
      children: [{ tag: 'input', attrs: { type: 'text' }, target: true }]
    },
    selector: '[data-field="due_date"] input[type="text"]',
    anchored: true,
    field: 'due_date'
  },
  {
    tree: {
      tag: 'section',
      attrs: { 'data-testid': 'grid' },
      children: [{ tag: 'div', attrs: { 'data-field': 'status' }, target: true }]
    },
    selector: '[data-field="status"]',
    anchored: true,
    field: 'status'
  },
  {
    tree: {
      tag: 'div',
      attrs: { 'data-cbv-tree-node': '6f1c2b3a-1234-4abc-9def-0123456789ab' },
      children: [{ tag: 'button', attrs: { role: 'treeitem' }, target: true }]
    },
    selector: '[data-cbv-tree-node] button[role="treeitem"]',
    anchored: true,
    field: null
  },
  {
    tree: { tag: 'div', attrs: { 'data-cbv-view-toggle': 'map' }, target: true },
    selector: '[data-cbv-view-toggle="map"]',
    anchored: true,
    field: null
  },
  {
    tree: { tag: 'nav', attrs: { id: 'sidebar' }, children: [{ tag: 'a', target: true }] },
    selector: '#sidebar a',
    anchored: true,
    field: null
  },
  {
    tree: { tag: 'div', attrs: { id: 'radix-:r4:' }, children: [{ tag: 'button', target: true }] },
    selector: 'button',
    anchored: false,
    field: null
  },
  {
    tree: {
      tag: 'form',
      attrs: { id: 'row-12345' },
      children: [{ tag: 'select', attrs: { name: 'priority' }, target: true }]
    },
    selector: 'select[name="priority"]',
    anchored: false,
    field: null
  },
  {
    tree: {
      tag: 'div',
      attrs: { 'data-testid': 'a "quoted" id' },
      children: [{ tag: 'span', target: true }]
    },
    selector: 'span',
    anchored: false,
    field: null
  }
]

describe('selectorFor on the replay DOM (shared vectors)', () => {
  for (const v of VECTORS) {
    it(`builds ${v.selector}`, () => {
      document.body.replaceChildren()
      const target = build(v.tree, null)
      expect(target).not.toBeNull()
      const node = domHookNode(target!)
      expect(selectorFor(node)).toEqual({ selector: v.selector, anchored: v.anchored })
      expect(nearestDataField(node)).toBe(v.field)
    })
  }

  it('the selector finds the element again', () => {
    document.body.innerHTML =
      '<div data-field="due_date"><label>Due</label><input type="text" value="secret"></div>'
    const input = document.querySelector('input')!
    const { selector } = selectorFor(domHookNode(input))
    expect(document.querySelector(selector)).toBe(input)
  })
})

describe('describeElement', () => {
  it('reports hooks and the nearest data-field / data-cbv-* ancestor, never text or value', () => {
    document.body.innerHTML = `
      <section data-cbv-quick-pick="orders">
        <div data-field="customer" data-state="open">
          <button data-testid="pick-customer" data-rr-is-shadow-host="x" data-tip="Pick a customer">Jane Doe</button>
          <input type="text" value="hunter2">
        </div>
      </section>`
    const btn = document.querySelector('button')!
    const info = describeElement(btn)
    expect(info).toEqual({
      tag: 'button',
      selector: '[data-testid="pick-customer"]',
      anchored: true,
      dataAttrs: [
        ['data-testid', 'pick-customer'],
        ['data-tip', 'Pick a customer']
      ],
      field: { name: 'customer', selector: '[data-field="customer"]' },
      cbv: {
        attr: 'data-cbv-quick-pick',
        value: 'orders',
        selector: '[data-cbv-quick-pick="orders"]'
      }
    })
    const input = describeElement(document.querySelector('input')!)
    expect(input.selector).toBe('[data-field="customer"] input[type="text"]')
    expect(JSON.stringify(input)).not.toContain('hunter2')
    expect(JSON.stringify(info)).not.toContain('Jane Doe')
  })
})

describe('geometry between the scaled iframe and the overlay', () => {
  // A 1280×720 replay drawn at half size, 100px right and 50px down the page.
  const frame = { left: 100, top: 50, width: 640, height: 360 }
  const scale = frameScale(frame, 1280)

  it('derives the scale from drawn vs layout width', () => {
    expect(scale).toBe(0.5)
    expect(frameScale(frame, 0)).toBe(1)
  })

  it('maps a pointer into iframe coordinates, null outside', () => {
    expect(pointInFrame(110, 60, frame, scale)).toEqual({ x: 20, y: 20 })
    expect(pointInFrame(90, 60, frame, scale)).toBeNull()
    expect(pointInFrame(800, 60, frame, scale)).toBeNull()
  })

  it('maps an element box back into overlay coordinates', () => {
    expect(
      boxInOverlay(
        { left: 200, top: 100, width: 80, height: 40 },
        frame,
        { left: 90, top: 40 },
        scale
      )
    ).toEqual({ left: 110, top: 60, width: 40, height: 20 })
  })
})
