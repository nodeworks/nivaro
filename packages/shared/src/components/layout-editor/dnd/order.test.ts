import { describe, expect, it } from 'vitest'
import {
  applyLayoutOps,
  type GroupRow,
  isCanvasSlot,
  type LayoutBundle,
  newGroup,
  newPlacement,
  type PlacementRow,
  ungroupedGroup
} from '../../../lib/layout-ops'
import type { DesignTarget } from '../design-context'
import { orderAfterDrop, placeAfterDrop } from './order'

const group = (key: string, sort: number, type = 'section', parent: string | null = null) =>
  ({ ...newGroup(key, key.toUpperCase(), type, parent), sort }) as GroupRow
const place = (field: string, group_key: string | null, sort: number) =>
  ({ ...newPlacement(field, group_key), sort }) as PlacementRow

// Top level: g1, Ungrouped, g2, container c (tabs t1..t3; t4 in container k), empty g3, pipeline.
const bundle: LayoutBundle = {
  layout: { id: 1, collection: 'orders' },
  rev: 'r1',
  groups: [
    group('g1', 0),
    ungroupedGroup(1),
    group('g2', 2),
    group('c', 3, 'container'),
    group('t1', 0, 'tab', 'c'),
    group('t2', 1, 'tab', 'c'),
    group('t3', 2, 'tab', 'c'),
    group('g3', 4),
    group('k', 6, 'container'),
    group('t4', 0, 'tab', 'k')
  ],
  placements: [
    place('a', 'g1', 0),
    place('b', 'g1', 1),
    place('c_', 'g1', 2),
    place('d', 'g2', 0),
    place('amount', 'g2', 1),
    place('f', 'g2', 2),
    place('u1', null, 0),
    place('u2', null, 1),
    place('amount', '__header__', 0),
    place('status', '__header__', 1),
    place('tf', 't1', 0),
    place('__pipeline__', null, 5)
  ]
}

const field = (f: string, g: string | null): DesignTarget => ({
  kind: 'field',
  field: f,
  group_key: g
})
const grp = (key: string): DesignTarget => ({ kind: 'group', key })
const zone = (b: LayoutBundle, g: string | null) =>
  b.placements
    .filter((p) => p.group_key === g && !isCanvasSlot(p))
    .sort((x, y) => x.sort - y.sort)
    .map((p) => p.field)
const top = (b: LayoutBundle, parent: string | null = null) =>
  [
    ...b.groups.filter((g) => g.parent_key === parent).map((g) => ({ k: g.key, s: g.sort })),
    ...(parent === null
      ? b.placements.filter((p) => isCanvasSlot(p)).map((p) => ({ k: p.field, s: p.sort }))
      : [])
  ]
    .sort((x, y) => x.s - y.s)
    .map((x) => x.k)

describe('orderAfterDrop', () => {
  it('moves a field into the middle of another group', () => {
    const ops = orderAfterDrop(bundle, field('a', 'g1'), field('amount', 'g2'), 'before')
    expect(ops).toEqual([
      { op: 'move', from: { field: 'a', group_key: 'g1' }, to_group_key: 'g2', index: 1 }
    ])
    const after = applyLayoutOps(bundle, ops)
    expect(zone(after, 'g2')).toEqual(['d', 'a', 'amount', 'f'])
    expect(zone(after, 'g1')).toEqual(['b', 'c_'])
  })

  it('drops after the hovered field', () => {
    const ops = orderAfterDrop(bundle, field('a', 'g1'), field('amount', 'g2'), 'after')
    expect(zone(applyLayoutOps(bundle, ops), 'g2')).toEqual(['d', 'amount', 'a', 'f'])
  })

  it('puts a field first when dropped on a group header', () => {
    const ops = orderAfterDrop(bundle, field('f', 'g2'), grp('g1'), 'before')
    expect(ops).toEqual([
      { op: 'move', from: { field: 'f', group_key: 'g2' }, to_group_key: 'g1', index: 0 }
    ])
    expect(zone(applyLayoutOps(bundle, ops), 'g1')).toEqual(['f', 'a', 'b', 'c_'])
  })

  it('appends when dropped on a group body below its fields', () => {
    const ops = orderAfterDrop(bundle, field('d', 'g2'), grp('g1'), 'after')
    expect(zone(applyLayoutOps(bundle, ops), 'g1')).toEqual(['a', 'b', 'c_', 'd'])
  })

  it('moves a field into an empty group', () => {
    const ops = orderAfterDrop(bundle, field('b', 'g1'), grp('g3'), 'after')
    expect(ops).toEqual([
      { op: 'move', from: { field: 'b', group_key: 'g1' }, to_group_key: 'g3', index: 0 }
    ])
    expect(zone(applyLayoutOps(bundle, ops), 'g3')).toEqual(['b'])
  })

  it('reorders inside one group', () => {
    const ops = orderAfterDrop(bundle, field('a', 'g1'), field('c_', 'g1'), 'after')
    expect(ops).toEqual([
      { op: 'move', from: { field: 'a', group_key: 'g1' }, to_group_key: 'g1', index: 2 }
    ])
    expect(zone(applyLayoutOps(bundle, ops), 'g1')).toEqual(['b', 'c_', 'a'])
  })

  it('emits nothing when the drop leaves the order as it is', () => {
    expect(orderAfterDrop(bundle, field('a', 'g1'), field('b', 'g1'), 'before')).toEqual([])
    expect(orderAfterDrop(bundle, field('b', 'g1'), field('a', 'g1'), 'after')).toEqual([])
    expect(orderAfterDrop(bundle, field('a', 'g1'), field('a', 'g1'), 'after')).toEqual([])
  })

  it('moves into and within the Ungrouped zone', () => {
    const into = orderAfterDrop(bundle, field('a', 'g1'), grp('__ungrouped__'), 'after')
    expect(into).toEqual([
      { op: 'move', from: { field: 'a', group_key: 'g1' }, to_group_key: null, index: 2 }
    ])
    const within = orderAfterDrop(bundle, field('u2', null), field('u1', null), 'before')
    expect(zone(applyLayoutOps(bundle, within), null)).toEqual(['u2', 'u1'])
  })

  it('moves only the dragged twin of a field placed twice', () => {
    const ops = orderAfterDrop(bundle, field('amount', 'g2'), field('a', 'g1'), 'before')
    expect(ops).toEqual([
      { op: 'move', from: { field: 'amount', group_key: 'g2' }, to_group_key: 'g1', index: 0 }
    ])
    const after = applyLayoutOps(bundle, ops)
    expect(zone(after, 'g1')).toEqual(['amount', 'a', 'b', 'c_'])
    expect(zone(after, '__header__')).toEqual(['amount', 'status'])
    expect(after.placements.filter((p) => p.field === 'amount')).toHaveLength(2)
  })

  it('reorders the header strip without touching the body twin', () => {
    const ops = orderAfterDrop(
      bundle,
      { kind: 'header', field: 'amount' },
      { kind: 'header', field: 'status' },
      'after'
    )
    expect(ops).toEqual([
      {
        op: 'move',
        from: { field: 'amount', group_key: '__header__' },
        to_group_key: '__header__',
        index: 1
      }
    ])
    const after = applyLayoutOps(bundle, ops)
    expect(zone(after, '__header__')).toEqual(['status', 'amount'])
    expect(zone(after, 'g2')).toEqual(['d', 'amount', 'f'])
  })

  it('refuses a drop into a group that already holds the field', () => {
    const twin = { ...bundle, placements: [...bundle.placements, place('a', 'g2', 3)] }
    expect(orderAfterDrop(twin, field('a', 'g1'), field('d', 'g2'), 'after')).toEqual([])
    expect(orderAfterDrop(twin, field('a', 'g1'), grp('g2'), 'before')).toEqual([])
    expect(orderAfterDrop(twin, field('a', 'g2'), grp('g1'), 'after')).toEqual([])
    // Without the twin the same drops do move.
    expect(orderAfterDrop(bundle, field('a', 'g1'), grp('g2'), 'before')).toHaveLength(1)
  })

  it('moves a field into an empty tab', () => {
    const ops = orderAfterDrop(bundle, field('a', 'g1'), grp('t2'), 'after')
    expect(ops).toEqual([
      { op: 'move', from: { field: 'a', group_key: 'g1' }, to_group_key: 't2', index: 0 }
    ])
    expect(zone(applyLayoutOps(bundle, ops), 't2')).toEqual(['a'])
    expect(orderAfterDrop(bundle, field('a', 'g1'), grp('t1'), 'after')).toEqual([
      { op: 'move', from: { field: 'a', group_key: 'g1' }, to_group_key: 't1', index: 1 }
    ])
  })

  it('refuses fields on containers and slot cards', () => {
    expect(orderAfterDrop(bundle, field('a', 'g1'), grp('c'), 'after')).toEqual([])
    const pipeline: DesignTarget = { kind: 'slot', field: '__pipeline__', group_key: null }
    expect(orderAfterDrop(bundle, field('a', 'g1'), pipeline, 'after')).toEqual([])
  })

  it('reorders groups when one is dropped over another group', () => {
    const ops = orderAfterDrop(bundle, grp('g3'), grp('g1'), 'before')
    expect(ops).toEqual([{ op: 'group_move', key: 'g3', parent_key: null, index: 0 }])
    expect(top(applyLayoutOps(bundle, ops))).toEqual([
      'g3',
      'g1',
      '__ungrouped__',
      'g2',
      'c',
      '__pipeline__',
      'k'
    ])
  })

  it("reorders groups when one is dropped over another group's field area", () => {
    const ops = orderAfterDrop(bundle, grp('g1'), field('amount', 'g2'), 'after')
    expect(ops).toEqual([{ op: 'group_move', key: 'g1', parent_key: null, index: 2 }])
    expect(top(applyLayoutOps(bundle, ops)).slice(0, 3)).toEqual(['__ungrouped__', 'g2', 'g1'])
    // A field inside a container's tab stands for the container.
    const intoTab = orderAfterDrop(bundle, grp('g1'), field('tf', 't1'), 'after')
    expect(intoTab).toEqual([{ op: 'group_move', key: 'g1', parent_key: null, index: 3 }])
    // Ungrouped fields stand for the Ungrouped zone.
    const overU = orderAfterDrop(bundle, grp('g3'), field('u1', null), 'before')
    expect(overU).toEqual([{ op: 'group_move', key: 'g3', parent_key: null, index: 1 }])
  })

  it('moves the Ungrouped zone and slot cards among the groups', () => {
    const u = orderAfterDrop(bundle, grp('__ungrouped__'), grp('g2'), 'after')
    expect(u).toEqual([{ op: 'group_move', key: '__ungrouped__', parent_key: null, index: 2 }])
    const pipeline: DesignTarget = { kind: 'slot', field: '__pipeline__', group_key: null }
    const p = orderAfterDrop(bundle, pipeline, grp('g1'), 'before')
    expect(p).toEqual([{ op: 'group_move', key: '__pipeline__', parent_key: null, index: 0 }])
    expect(top(applyLayoutOps(bundle, p))[0]).toBe('__pipeline__')
  })

  it('reorders tabs inside their container', () => {
    const ops = orderAfterDrop(bundle, grp('t1'), grp('t3'), 'after')
    expect(ops).toEqual([{ op: 'group_move', key: 't1', parent_key: 'c', index: 2 }])
    expect(top(applyLayoutOps(bundle, ops), 'c')).toEqual(['t2', 't3', 't1'])
  })

  it('never moves a tab out of its container', () => {
    expect(orderAfterDrop(bundle, grp('t1'), grp('t4'), 'before')).toEqual([])
    expect(orderAfterDrop(bundle, grp('t1'), grp('g1'), 'before')).toEqual([])
    expect(orderAfterDrop(bundle, grp('g1'), grp('t2'), 'before')).toEqual([
      { op: 'group_move', key: 'g1', parent_key: null, index: 2 }
    ])
  })

  it('keeps the stored order when sorts tie', () => {
    const tied: LayoutBundle = {
      ...bundle,
      placements: bundle.placements.map((p) => (p.group_key === 'g1' ? { ...p, sort: 0 } : p))
    }
    const order = zone(applyLayoutOps(tied, [{ op: 'layout_update', patch: {} }]), 'g1')
    const ops = orderAfterDrop(tied, field(order[0], 'g1'), field(order[2], 'g1'), 'after')
    expect(zone(applyLayoutOps(tied, ops), 'g1')).toEqual([order[1], order[2], order[0]])
  })

  describe('slot cards that live in the canvas order (owners, PDF, extension slots)', () => {
    const withSlots: LayoutBundle = {
      ...bundle,
      placements: [
        ...bundle.placements,
        // A third Ungrouped field keeps zone indexes apart from canvas indexes.
        place('u3', null, 2),
        place('__owners__', 'g1', 3),
        place('__pdf__', 'g2', 3),
        place('__ext_acme__', 'g1', 4)
      ]
    }
    const slot = (f: string, g: string | null): DesignTarget => ({
      kind: 'slot',
      field: f,
      group_key: g
    })

    it.each([
      ['__owners__', 'g1'],
      ['__pdf__', 'g2'],
      ['__ext_acme__', 'g1']
    ])('%s leaving a section for Ungrouped lands beside the Ungrouped card', (f, g) => {
      const below = orderAfterDrop(withSlots, slot(f, g), grp('__ungrouped__'), 'after')
      expect(below).toEqual([
        { op: 'move', from: { field: f, group_key: g }, to_group_key: null, index: 2 }
      ])
      const after = applyLayoutOps(withSlots, below)
      expect(top(after).slice(0, 3)).toEqual(['g1', '__ungrouped__', f])
      expect(zone(after, null)).toEqual(['u1', 'u2', 'u3'])
      const above = orderAfterDrop(withSlots, slot(f, g), field('u3', null), 'before')
      expect(top(applyLayoutOps(withSlots, above)).slice(0, 3)).toEqual(['g1', f, '__ungrouped__'])
    })

    it.each([
      '__owners__',
      '__pdf__',
      '__ext_acme__'
    ])('%s on the canvas reorders among the groups', (f) => {
      const onCanvas: LayoutBundle = {
        ...bundle,
        placements: [...bundle.placements, place(f, null, 7)]
      }
      const ops = orderAfterDrop(onCanvas, slot(f, null), grp('g1'), 'before')
      expect(ops).toEqual([{ op: 'group_move', key: f, parent_key: null, index: 0 }])
      expect(top(applyLayoutOps(onCanvas, ops))[0]).toBe(f)
    })
  })
})

describe('placeAfterDrop', () => {
  it('places a new field beside the field it is dropped on', () => {
    const ops = placeAfterDrop(bundle, 'vendor', field('amount', 'g2'), 'after')
    expect(ops).toEqual([{ op: 'place', field: 'vendor', group_key: 'g2', index: 2 }])
    expect(zone(applyLayoutOps(bundle, ops), 'g2')).toEqual(['d', 'amount', 'vendor', 'f'])
  })

  it('a section header puts it first; the rest of an empty section puts it last', () => {
    expect(placeAfterDrop(bundle, 'vendor', grp('g1'), 'before')).toEqual([
      { op: 'place', field: 'vendor', group_key: 'g1', index: 0 }
    ])
    const ops = placeAfterDrop(bundle, 'vendor', grp('g3'), 'after')
    expect(ops).toEqual([{ op: 'place', field: 'vendor', group_key: 'g3', index: 0 }])
    expect(zone(applyLayoutOps(bundle, ops), 'g3')).toEqual(['vendor'])
  })

  it('the Ungrouped zone takes fields as group_key null', () => {
    expect(placeAfterDrop(bundle, 'vendor', field('u1', null), 'after')).toEqual([
      { op: 'place', field: 'vendor', group_key: null, index: 1 }
    ])
  })

  it('never places a field twice in one group, nor onto a container', () => {
    expect(placeAfterDrop(bundle, 'amount', field('d', 'g2'), 'after')).toEqual([])
    expect(placeAfterDrop(bundle, 'vendor', grp('c'), 'after')).toEqual([])
  })

  it('header strip tiles take a new tile beside them', () => {
    const ops = placeAfterDrop(bundle, 'vendor', { kind: 'header', field: 'amount' }, 'after')
    expect(ops).toEqual([{ op: 'place', field: 'vendor', group_key: '__header__', index: 1 }])
    // Owners as a header tile, not a slot card.
    expect(
      placeAfterDrop(bundle, '__owners__', { kind: 'header', field: 'status' }, 'before')
    ).toEqual([{ op: 'place', field: '__owners__', group_key: '__header__', index: 1 }])
  })

  it('a slot card goes into the page order beside the section it is dropped on', () => {
    const ops = placeAfterDrop(bundle, '__comments__', grp('g2'), 'before')
    expect(ops).toEqual([{ op: 'place', field: '__comments__', group_key: null, index: 2 }])
    expect(top(applyLayoutOps(bundle, ops)).slice(0, 4)).toEqual([
      'g1',
      '__ungrouped__',
      '__comments__',
      'g2'
    ])
    // Already a card on the form: nothing.
    expect(placeAfterDrop(bundle, '__pipeline__', grp('g2'), 'before')).toEqual([])
  })

  it('carries the patch (a widget binding) on the place op', () => {
    const patch = { widget_id: 4 }
    expect(placeAfterDrop(bundle, '__widget_4__', field('a', 'g1'), 'before', patch)).toEqual([
      { op: 'place', field: '__widget_4__', group_key: 'g1', index: 0, patch }
    ])
  })
})
