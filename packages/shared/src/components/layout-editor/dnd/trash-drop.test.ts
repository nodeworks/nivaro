import type { CollisionDetection, DroppableContainer } from '@dnd-kit/core'
import { describe, expect, it, vi } from 'vitest'
import {
  applyLayoutOps,
  HEADER_GROUP_KEY,
  type LayoutBundle,
  newGroup,
  newPlacement,
  UNGROUPED_KEY,
  ungroupedGroup
} from '../../../lib/layout-ops'
import type { DndNodeData } from './collision'
import { TRASH_DROP_ID, trashAwareCollision, trashDropData, trashPlan } from './trash-drop'

const bundle: LayoutBundle = {
  layout: { id: 1, collection: 'orders' },
  rev: 'r',
  groups: [
    { ...newGroup('g1', 'G1', 'section', null), sort: 0 },
    { ...newGroup('t1', 'Tab 1', 'tab', 'g1'), sort: 0 },
    { ...newGroup('t2', 'Tab 2', 'tab', 't1'), sort: 0 },
    { ...newGroup('g2', 'G2', 'section', null), sort: 1 },
    ungroupedGroup(2)
  ],
  placements: [
    newPlacement('a', 'g1'),
    newPlacement('b', 't1'),
    newPlacement('c', 't2'),
    newPlacement('d', 'g2'),
    newPlacement('e', null),
    newPlacement('title', HEADER_GROUP_KEY)
  ]
}

const field = (f: string, g: string | null): DndNodeData => ({
  target: { kind: 'field', field: f, group_key: g },
  role: { kind: 'item', zone: g }
})
const section = (key: string): DndNodeData => ({
  target: { kind: 'group', key },
  role: { kind: 'group', key, parent: null, body: true }
})

describe('trashPlan', () => {
  it('a field loses its placement only', () => {
    expect(trashPlan(bundle, field('a', 'g1'))).toEqual({
      ops: [{ op: 'remove', at: { field: 'a', group_key: 'g1' } }],
      kind: 'field',
      holds: 0
    })
    expect(trashPlan(bundle, field('e', null))?.ops).toEqual([
      { op: 'remove', at: { field: 'e', group_key: null } }
    ])
  })

  it('a header item comes out of the header strip', () => {
    const d: DndNodeData = {
      target: { kind: 'header', field: 'title' },
      role: { kind: 'item', zone: HEADER_GROUP_KEY }
    } as DndNodeData
    expect(trashPlan(bundle, d)?.ops).toEqual([
      { op: 'remove', at: { field: 'title', group_key: HEADER_GROUP_KEY } }
    ])
  })

  it('a section leaves with its tabs and every field in them', () => {
    const plan = trashPlan(bundle, section('g1'))!
    expect(plan.kind).toBe('section')
    expect(plan.holds).toBe(3)
    expect(plan.ops.map((o) => (o as { key: string }).key)).toEqual(['t2', 't1', 'g1'])
    const after = applyLayoutOps(bundle, plan.ops)
    expect(after.groups.map((g) => g.key).sort()).toEqual(['g2', UNGROUPED_KEY].sort())
    expect(after.placements.map((p) => p.field).sort()).toEqual(['d', 'e', 'title'])
  })

  it('refuses what cannot go in the trash', () => {
    expect(trashPlan(bundle, section(UNGROUPED_KEY))).toBeNull()
    expect(trashPlan(bundle, section('__apply_values__'))).toBeNull()
    expect(trashPlan(bundle, field('zzz', 'g1'))).toBeNull()
    expect(trashPlan(bundle, { ...field('a', 'g1'), add: { field: 'a' } } as never)).toBeNull()
    expect(trashPlan(null, field('a', 'g1'))).toBeNull()
  })
})

describe('trashAwareCollision', () => {
  const trash = {
    id: TRASH_DROP_ID,
    disabled: false,
    data: { current: { layoutTrash: true } }
  } as unknown as DroppableContainer
  const run = (active: DndNodeData, pointer: { x: number; y: number }) => {
    const inner: CollisionDetection = vi.fn(() => [{ id: 'inner' }])
    const detect = trashAwareCollision(inner, (d) => trashPlan(bundle, d) != null)
    const out = detect({
      active: { id: 'x', data: { current: active }, rect: { current: {} } },
      droppableContainers: [trash],
      droppableRects: new Map([
        [TRASH_DROP_ID, { left: 100, right: 300, top: 500, bottom: 560, width: 200, height: 60 }]
      ]),
      pointerCoordinates: pointer,
      collisionRect: { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }
    } as never)
    return out.map((c) => c.id)
  }

  it('the trash wins under the pointer for a removable drag', () => {
    expect(run(field('a', 'g1'), { x: 150, y: 520 })).toEqual([TRASH_DROP_ID])
    expect(trashDropData(trash.data.current)).not.toBeNull()
  })

  it('elsewhere, or for something the trash refuses, the canvas decides', () => {
    expect(run(field('a', 'g1'), { x: 150, y: 100 })).toEqual(['inner'])
    expect(run(section(UNGROUPED_KEY), { x: 150, y: 520 })).toEqual(['inner'])
  })
})
