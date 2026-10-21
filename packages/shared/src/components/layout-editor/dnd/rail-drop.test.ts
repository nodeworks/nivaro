import type { ClientRect, DroppableContainer } from '@dnd-kit/core'
import { describe, expect, it } from 'vitest'
import { type LayoutBundle, newGroup, newPlacement, ungroupedGroup } from '../../../lib/layout-ops'
import type { DndNodeData } from './collision'
import { copyableGroup, railAwareCollision, railDropData, railDropId } from './rail-drop'

const bundle: LayoutBundle = {
  layout: { id: 1, collection: 'orders' },
  rev: 'r',
  groups: [{ ...newGroup('g1', 'G1', 'section', null), sort: 0 }, ungroupedGroup(1)],
  placements: [newPlacement('a', 'g1')]
}

const rect = (left: number, top: number, width: number, height: number): ClientRect => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height
})

const section: DndNodeData = {
  target: { kind: 'group', key: 'g1' },
  role: { kind: 'group', key: 'g1', parent: null, body: true }
}
const field: DndNodeData = {
  target: { kind: 'field', field: 'a', group_key: 'g1' },
  role: { kind: 'item', zone: 'g1' }
}

function args(active: DndNodeData, pointer: { x: number; y: number }) {
  const rail = {
    id: railDropId(24),
    disabled: false,
    data: { current: { railLayoutId: 24 } }
  } as unknown as DroppableContainer
  const canvas = { id: 'group:g1', disabled: false, data: { current: section } }
  return {
    active: { id: 'x', data: { current: active }, rect: { current: {} } },
    collisionRect: rect(pointer.x, pointer.y, 10, 10),
    droppableRects: new Map([
      [rail.id, rect(0, 0, 200, 40)],
      ['group:g1', rect(300, 0, 400, 200)]
    ]),
    droppableContainers: [rail, canvas],
    pointerCoordinates: pointer
  } as never
}

describe('rail drop (#2584)', () => {
  const detect = railAwareCollision((d) => copyableGroup(bundle, d) != null)

  it('a dragged section over a rail row collides with that row', () => {
    const hits = detect(args(section, { x: 50, y: 20 }))
    expect(hits.map((h) => h.id)).toEqual([railDropId(24)])
  })

  it('a field never lands on a rail row', () => {
    const hits = detect(args(field, { x: 50, y: 20 }))
    expect(hits.map((h) => h.id)).not.toContain(railDropId(24))
  })

  it('only real sections copy: never the Ungrouped zone or an Add panel row', () => {
    expect(copyableGroup(bundle, section)).toBe('g1')
    expect(
      copyableGroup(bundle, {
        target: { kind: 'group', key: '__ungrouped__' },
        role: { kind: 'group', key: '__ungrouped__', parent: null, body: true }
      })
    ).toBeNull()
    expect(copyableGroup(bundle, { ...section, add: { field: 'x', label: 'X' } })).toBeNull()
    expect(railDropData({ railLayoutId: 3 })).toEqual({ railLayoutId: 3 })
    expect(railDropData(section)).toBeNull()
  })
})
