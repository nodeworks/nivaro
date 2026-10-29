import type { CollisionDetection, DroppableContainer } from '@dnd-kit/core'
import { describe, expect, it, vi } from 'vitest'
import {
  applyLayoutOps,
  type LayoutBundle,
  newGroup,
  newPlacement,
  ungroupedGroup
} from '../../../lib/layout-ops'
import { withPin } from '../pin'
import { mergeBlocked, mergePlan } from '../section-structure'
import type { DndNodeData } from './collision'
import { inMergeZone, MERGE_EDGE, mergeAwareCollision } from './merge-drop'

const bundle: LayoutBundle = {
  layout: { id: 1, collection: 'orders' },
  rev: 'r',
  groups: [
    { ...newGroup('g1', 'Details', 'section', null), sort: 0 },
    { ...newGroup('g2', 'Money', 'section', null), sort: 1 },
    { ...newGroup('g3', 'Notes', 'section', null), sort: 2 },
    { ...newGroup('tabs', 'Tabs', 'container', null), sort: 3 },
    { ...newGroup('t1', 'One', 'tab', 'tabs'), sort: 0 },
    ungroupedGroup(4)
  ],
  placements: [
    { ...newPlacement('a', 'g1'), sort: 0 },
    { ...newPlacement('b', 'g1'), sort: 1 },
    { ...newPlacement('n', 'g3'), sort: 0 },
    { ...newPlacement('a', 'g3'), sort: 1 },
    { ...newPlacement('x', 't1'), sort: 0 }
  ]
}

const zone = (b: LayoutBundle, g: string) =>
  b.placements
    .filter((p) => p.group_key === g)
    .sort((x, y) => x.sort - y.sort)
    .map((p) => p.field)

describe('mergePlan', () => {
  it('a section dropped on another (not only its neighbour) joins it', () => {
    const plan = mergePlan(bundle, 'g3', 'g1')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.label).toBe('Join Notes into Details')
    const after = applyLayoutOps(bundle, plan.ops)
    // A field both hold shows once.
    expect(zone(after, 'g1')).toEqual(['a', 'b', 'n'])
    expect(after.groups.some((g) => g.key === 'g3')).toBe(false)
    expect(plan.notes).toContain('1 field in both shows once')
  })

  it('refuses itself, other kinds, other holders and pinned sections', () => {
    expect(mergeBlocked(bundle, 'g1', 'g1')).toBe('It is the same section')
    expect(mergeBlocked(bundle, 't1', 'g1')).toBe('A tab joins another tab')
    expect(mergeBlocked(bundle, 'tabs', 'g1')).toBe('Only sections, tabs and steps join')
    const pinned = {
      ...bundle,
      groups: bundle.groups.map((g) =>
        g.key === 'g1' ? { ...g, swap_config: withPin(null, true) } : g
      )
    }
    expect(mergeBlocked(pinned, 'g2', 'g1')).toBe('Unpin it first')
    expect(mergeBlocked(bundle, 'g2', 'g1')).toBeNull()
  })
})

describe('inMergeZone', () => {
  const r = { left: 0, top: 100, width: 400, height: 300 }
  it('a stacked section: its header below the top edge joins', () => {
    expect(inMergeZone(r, 40, 'y', { x: 200, y: 100 + MERGE_EDGE + 1 })).toBe(true)
    expect(inMergeZone(r, 40, 'y', { x: 200, y: 104 })).toBe(false)
    expect(inMergeZone(r, 40, 'y', { x: 200, y: 160 })).toBe(false)
    expect(inMergeZone(r, 0, 'y', { x: 200, y: 120 })).toBe(false)
  })
  it('a tab: its middle joins, its outer quarters reorder', () => {
    const tab = { left: 0, top: 0, width: 200, height: 40 }
    expect(inMergeZone(tab, 40, 'x', { x: 100, y: 20 })).toBe(true)
    expect(inMergeZone(tab, 40, 'x', { x: 20, y: 20 })).toBe(false)
  })
})

describe('mergeAwareCollision', () => {
  const group = (key: string, header = 40): DndNodeData => ({
    target: { kind: 'group', key },
    role: { kind: 'group', key, parent: null, body: true },
    headerHeight: () => header
  })
  const run = (inner: CollisionDetection, active: DndNodeData, p: { x: number; y: number }) => {
    const over = { id: 'group:g1', data: { current: group('g1') } } as unknown as DroppableContainer
    const detect = mergeAwareCollision(inner, () => true)
    return detect({
      active: { id: 'x', data: { current: active }, rect: { current: {} } },
      collisionRect: { left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10 },
      droppableRects: new Map([
        ['group:g1', { left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200 }]
      ]),
      droppableContainers: [over],
      pointerCoordinates: p
    } as never)
  }
  const inner = vi.fn(((args) => [
    {
      id: 'group:g1',
      data: {
        droppableContainer: args.droppableContainers[0],
        hint: { side: 'before', axis: 'y', body: false }
      }
    }
  ]) as CollisionDetection)

  it('marks a section over a header as a join', () => {
    const out = run(inner, group('g2'), { x: 100, y: 25 })
    expect((out[0].data as { hint: { merge?: boolean } }).hint.merge).toBe(true)
  })
  it('the header top edge and the body still reorder; a field never joins', () => {
    expect((run(inner, group('g2'), { x: 100, y: 4 })[0].data as { hint: object }).hint).toEqual({
      side: 'before',
      axis: 'y',
      body: false
    })
    expect(
      (run(inner, group('g2'), { x: 100, y: 120 })[0].data as { hint: { merge?: boolean } }).hint
        .merge
    ).toBeUndefined()
    const field: DndNodeData = {
      target: { kind: 'field', field: 'a', group_key: 'g1' },
      role: { kind: 'item', zone: 'g1' }
    }
    expect(
      (run(inner, field, { x: 100, y: 25 })[0].data as { hint: { merge?: boolean } }).hint.merge
    ).toBeUndefined()
  })
})
