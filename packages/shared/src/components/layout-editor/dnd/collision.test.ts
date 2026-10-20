import type {
  ClientRect,
  CollisionDetection,
  DroppableContainer,
  KeyboardCoordinateGetter
} from '@dnd-kit/core'
import { describe, expect, it } from 'vitest'
import { type LayoutBundle, newGroup, newPlacement, ungroupedGroup } from '../../../lib/layout-ops'
import { type DesignTarget, targetKey } from '../design-context'
import {
  type DndNodeData,
  type DndRole,
  type DropHint,
  dndRole,
  typedCollision,
  typedKeyboardCoordinates
} from './collision'

const bundle: LayoutBundle = {
  layout: { id: 1, collection: 'orders' },
  rev: 'r',
  groups: [
    { ...newGroup('g1', 'G1', 'section', null), sort: 0 },
    { ...newGroup('g2', 'G2', 'section', null), sort: 1 },
    { ...newGroup('g3', 'G3', 'section', null), sort: 2 },
    { ...newGroup('c', 'C', 'container', null), sort: 3 },
    { ...newGroup('t1', 'T1', 'tab', 'c'), sort: 0 },
    { ...newGroup('t2', 'T2', 'tab', 'c'), sort: 1 },
    ungroupedGroup(4)
  ],
  placements: [newPlacement('a', 'g1'), newPlacement('d', 'g2'), newPlacement('e', 'g2')]
}

const rect = (left: number, top: number, width: number, height: number): ClientRect => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height
})

type Node = { t: DesignTarget; r: ClientRect; header?: number; role?: DndRole; id?: string }
// g1 0-200 (header 40) holding a; g2 220-420 (header 40) holding d and e side by
// side; empty g3 440-540; container c with tab buttons t1 | t2 at 560.
const nodes: Node[] = [
  { t: { kind: 'group', key: 'g1' }, r: rect(0, 0, 600, 200), header: 40 },
  { t: { kind: 'field', field: 'a', group_key: 'g1' }, r: rect(20, 50, 560, 40) },
  { t: { kind: 'group', key: 'g2' }, r: rect(0, 220, 600, 200), header: 40 },
  { t: { kind: 'field', field: 'd', group_key: 'g2' }, r: rect(20, 270, 270, 40) },
  { t: { kind: 'field', field: 'e', group_key: 'g2' }, r: rect(310, 270, 270, 40) },
  { t: { kind: 'group', key: 'g3' }, r: rect(0, 440, 600, 100), header: 40 },
  { t: { kind: 'group', key: 'c' }, r: rect(0, 560, 600, 200) },
  { t: { kind: 'group', key: 't1' }, r: rect(20, 560, 80, 36) },
  { t: { kind: 'group', key: 't2' }, r: rect(100, 560, 80, 36) },
  { t: { kind: 'header', field: 'amount' }, r: rect(0, -60, 120, 50) }
]

const dataOf = (n: Node): DndNodeData => ({
  target: n.t,
  role: n.role ?? dndRole(bundle, n.t) ?? { kind: 'header' },
  headerHeight: n.header ? () => n.header as number : undefined
})

function args(
  active: DesignTarget,
  pointer: { x: number; y: number } | null,
  collisionRect = rect(0, 0, 10, 10),
  extra: Node[] = []
): Parameters<CollisionDetection>[0] {
  const all = [...nodes, ...extra]
  const idOf = (n: Node) => n.id ?? targetKey(n.t)
  const containers = all.map(
    (n) =>
      ({
        id: idOf(n),
        key: idOf(n),
        disabled: false,
        data: { current: dataOf(n) },
        node: { current: null },
        rect: { current: n.r }
      }) as unknown as DroppableContainer
  )
  const activeNode = nodes.find((n) => targetKey(n.t) === targetKey(active)) as Node
  return {
    active: {
      id: targetKey(active),
      data: { current: dataOf(activeNode) },
      rect: { current: { initial: activeNode.r, translated: activeNode.r } }
    },
    collisionRect,
    droppableRects: new Map(all.map((n) => [idOf(n), n.r])),
    droppableContainers: containers,
    pointerCoordinates: pointer
  }
}

const hit = (a: Parameters<CollisionDetection>[0]) => {
  const [c] = typedCollision(a)
  return c ? { id: c.id, hint: (c.data as { hint: DropHint }).hint } : null
}

const A = { kind: 'field', field: 'a', group_key: 'g1' } as const

describe('typedCollision', () => {
  it('a field lands on the field under the pointer, not its group', () => {
    expect(hit(args(A, { x: 100, y: 290 }))).toEqual({
      id: 'field:d:g2',
      hint: { side: 'before', axis: 'x', body: false }
    })
    expect(hit(args(A, { x: 560, y: 300 }))?.hint.side).toBe('after')
  })

  it('a field over a group header goes first in that group', () => {
    expect(hit(args(A, { x: 300, y: 230 }))).toEqual({
      id: 'group:g2',
      hint: { side: 'before', axis: 'y', body: true }
    })
  })

  it('a field in the gap of a group body snaps to the nearest field there', () => {
    expect(hit(args(A, { x: 500, y: 400 }))?.id).toBe('field:e:g2')
  })

  it('a field over an empty group body is appended to it', () => {
    expect(hit(args(A, { x: 300, y: 500 }))).toEqual({
      id: 'group:g3',
      hint: { side: 'after', axis: 'y', body: true }
    })
  })

  it('fields never collide with containers or header tiles', () => {
    expect(hit(args(A, { x: 300, y: 700 }))).toBeNull()
    expect(hit(args(A, { x: 300, y: 580 }))).toBeNull()
    expect(hit(args(A, { x: 50, y: -40 }))).toBeNull()
  })

  it('a group ignores the fields of the group it is over', () => {
    expect(hit(args({ kind: 'group', key: 'g1' }, { x: 100, y: 290 }))).toEqual({
      id: 'group:g2',
      hint: { side: 'before', axis: 'y', body: false }
    })
    expect(hit(args({ kind: 'group', key: 'g1' }, { x: 400, y: 400 }))?.hint.side).toBe('after')
  })

  it('a top-level group passes over tabs to their container', () => {
    expect(hit(args({ kind: 'group', key: 'g1' }, { x: 40, y: 570 }))?.id).toBe('group:c')
  })

  it('a tab collides only with tabs of the same container', () => {
    const t1 = { kind: 'group', key: 't1' } as const
    expect(hit(args(t1, { x: 170, y: 570 }))).toEqual({
      id: 'group:t2',
      hint: { side: 'after', axis: 'x', body: false }
    })
    expect(hit(args(t1, { x: 300, y: 300 }))).toBeNull()
  })

  it('header tiles collide only with header tiles', () => {
    const h = { kind: 'header', field: 'amount' } as const
    expect(hit(args(h, { x: 100, y: 290 }))).toBeNull()
    expect(hit(args(h, { x: 100, y: -40 }))?.id).toBe('header:amount')
  })

  it('without a pointer (keyboard) the dragged rect centre decides', () => {
    expect(hit(args(A, null, rect(300, 286, 10, 10)))?.id).toBe('field:e:g2')
  })

  // The open tab's pane (container c, 600-760) registers as a body for its tab.
  const pane = (key: string): Node => ({
    t: { kind: 'group', key },
    r: rect(0, 600, 600, 160),
    role: { kind: 'body', key },
    id: `body:${key}`
  })

  it('a field over an empty tab pane goes into that tab', () => {
    expect(hit(args(A, { x: 300, y: 700 }, undefined, [pane('t2')]))).toEqual({
      id: 'body:t2',
      hint: { side: 'after', axis: 'y', body: true }
    })
  })

  it('a field in a tab pane far from its fields snaps to the nearest one', () => {
    const tf: Node = {
      t: { kind: 'field', field: 'tf', group_key: 't1' },
      r: rect(20, 610, 270, 40)
    }
    expect(hit(args(A, { x: 550, y: 740 }, undefined, [pane('t1'), tf]))?.id).toBe('field:tf:t1')
  })

  it('groups and tabs never collide with a pane', () => {
    const t1 = { kind: 'group', key: 't1' } as const
    const g1 = { kind: 'group', key: 'g1' } as const
    expect(hit(args(t1, { x: 300, y: 700 }, undefined, [pane('t2')]))).toBeNull()
    expect(hit(args(g1, { x: 300, y: 700 }, undefined, [pane('t2')]))?.id).toBe('group:c')
  })
})

describe('typedKeyboardCoordinates', () => {
  // An Add panel row, left of the canvas: a drag source, never a drop target.
  const addRow = rect(-300, 0, 240, 30)
  const addData: DndNodeData = {
    target: { kind: 'field', field: 'vendor', group_key: '__add__' },
    role: { kind: 'item', zone: '__add__' },
    add: { field: 'vendor', label: 'Vendor' }
  }
  function step(code: string, from: ClientRect, at: { x: number; y: number }) {
    const a = args(A, null, from)
    const ctx = {
      active: { id: 'field:vendor:__add__', data: { current: addData } },
      collisionRect: from,
      droppableRects: a.droppableRects,
      droppableContainers: { getEnabled: () => a.droppableContainers }
    }
    const event = { code, preventDefault() {} } as KeyboardEvent
    return typedKeyboardCoordinates(event, {
      active: 'field:vendor:__add__',
      currentCoordinates: at,
      context: ctx
    } as unknown as Parameters<KeyboardCoordinateGetter>[1])
  }

  it('an Add row moves to the first stop on the first arrow down, the last on arrow up', () => {
    // Stops in reading order: a, d, e, empty g3, empty tabs t1, t2. Field a's centre is (300, 70).
    expect(step('ArrowDown', addRow, { x: -180, y: 15 })).toEqual({ x: 301, y: 71 })
    // Tab t2's centre is (140, 578).
    expect(step('ArrowUp', addRow, { x: -180, y: 15 })).toEqual({ x: 139, y: 577 })
  })
})
