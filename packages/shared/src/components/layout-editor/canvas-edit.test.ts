import { describe, expect, it } from 'vitest'
import {
  applyLayoutOps,
  type LayoutBundle,
  newGroup,
  newPlacement,
  type PlacementRow,
  ungroupedGroup
} from '../../lib/layout-ops'
import { fillRow, gapCount, gridRows, packRows, planAutoArrange } from './auto-arrange'
import { type DesignTarget, nextSelection } from './design-context'
import {
  fieldZones,
  flagOps,
  inPageOrder,
  moveToZoneOps,
  selectedPlacements,
  widthOps,
  zoneItems
} from './field-zones'
import { altArrowMove } from './keyboard-move'

// #2583 multi-select, #2603 Alt+arrow, #2604 auto-arrange, #2602 table bulk edits.

const place = (
  field: string,
  group: string | null,
  sort: number,
  over: Partial<PlacementRow> = {}
) => ({
  ...newPlacement(field, group),
  sort,
  ...over
})

function bundle(): LayoutBundle {
  return {
    layout: { id: 1, collection: 'orders', name: 'Form', layout_type: 'grouped' },
    groups: [
      { ...newGroup('main', 'Main', 'section', null), sort: 0 },
      { ...newGroup('tabs', 'Details', 'container', null), sort: 1 },
      { ...newGroup('t1', 'Billing', 'tab', 'tabs'), sort: 0 },
      { ...newGroup('t2', 'Shipping', 'tab', 'tabs'), sort: 1 },
      { ...newGroup('note', 'Note', 'content', null), sort: 2 },
      ungroupedGroup(3)
    ],
    placements: [
      place('a', 'main', 0, { col_span: 6 }),
      place('b', 'main', 1, { col_span: 4 }),
      place('c', 'main', 2, { col_span: 6 }),
      place('d', 'main', 3, { col_span: 4 }),
      place('e', 't1', 0),
      place('f', 't2', 0),
      place('a', 't2', 1),
      place('u', null, 0),
      place('__comments__', null, 4)
    ],
    rev: 'r'
  }
}

const order = (b: LayoutBundle, zone: string | null) => zoneItems(b, zone).map((p) => p.field)
const f = (field: string, group_key: string | null): DesignTarget => ({
  kind: 'field',
  field,
  group_key
})

describe('selection', () => {
  it('a plain click selects one; an additive click adds and removes fields', () => {
    let s = nextSelection([], f('a', 'main'))
    s = nextSelection(s, f('b', 'main'), { additive: true })
    expect(s).toHaveLength(2)
    s = nextSelection(s, f('a', 'main'), { additive: true })
    expect(s).toEqual([f('b', 'main')])
    expect(nextSelection(s, f('c', 'main'))).toEqual([f('c', 'main')])
  })

  it('sections and page cards are never part of a multi-selection', () => {
    const g: DesignTarget = { kind: 'group', key: 'main' }
    expect(nextSelection([f('a', 'main')], g, { additive: true })).toEqual([g])
    expect(nextSelection([g], f('a', 'main'), { additive: true })).toEqual([f('a', 'main')])
    const card: DesignTarget = { kind: 'slot', field: '__comments__', group_key: null }
    expect(nextSelection([f('a', 'main')], card, { additive: true })).toEqual([card])
  })
})

describe('field zones and bulk ops', () => {
  it('lists the zones fields can sit in, in page order', () => {
    expect(fieldZones(bundle()).map((z) => [z.key, z.label])).toEqual([
      ['main', 'Main'],
      ['t1', 'Details › Billing'],
      ['t2', 'Details › Shipping'],
      [null, 'Ungrouped']
    ])
  })

  it('sets one width and flags for every selected field in one batch', () => {
    const b = bundle()
    const rows = selectedPlacements(b, [f('a', 'main'), f('b', 'main'), f('e', 't1')])
    const ops = widthOps(rows, 6)
    expect(ops).toHaveLength(2) // a is already ½
    const after = applyLayoutOps(b, [...ops, ...flagOps(rows, 'required', true)])
    expect(zoneItems(after, 'main').map((p) => p.col_span)).toEqual([6, 6, 6, 4])
    expect(
      after.placements.filter((p) => (p.overrides as { required?: boolean })?.required)
    ).toHaveLength(3)
    const full = applyLayoutOps(after, widthOps(selectedPlacements(after, [f('a', 'main')]), 12))
    expect(full.placements.find((p) => p.field === 'a' && p.group_key === 'main')?.col_span).toBe(
      null
    )
    const off = flagOps(selectedPlacements(after, [f('a', 'main')]), 'required', false)
    expect(applyLayoutOps(after, off).placements.find((p) => p.field === 'a')?.overrides).toBe(null)
  })

  it('moves a selection to the end of another section, keeping page order and skipping twins', () => {
    const b = bundle()
    const rows = selectedPlacements(b, [f('c', 'main'), f('a', 'main'), f('e', 't1')])
    expect(inPageOrder(b, rows).map((p) => p.field)).toEqual(['a', 'c', 'e'])
    const plan = moveToZoneOps(b, rows, 't2')
    expect(plan.skipped).toBe(1) // t2 already holds a
    const after = applyLayoutOps(b, plan.ops)
    expect(order(after, 't2')).toEqual(['f', 'a', 'c', 'e'])
    expect(order(after, 'main')).toEqual(['a', 'b', 'd'])
    expect(plan.moved).toEqual([
      { field: 'c', group_key: 't2' },
      { field: 'e', group_key: 't2' }
    ])
  })
})

describe('Alt+arrow', () => {
  it('moves a field up and down within its section', () => {
    const b = bundle()
    const m = altArrowMove(b, f('b', 'main'), 'up')
    expect(m?.next).toEqual(f('b', 'main'))
    expect(order(applyLayoutOps(b, m?.ops ?? []), 'main')).toEqual(['b', 'a', 'c', 'd'])
    const d = altArrowMove(b, f('b', 'main'), 'down')
    expect(order(applyLayoutOps(b, d?.ops ?? []), 'main')).toEqual(['a', 'c', 'b', 'd'])
    expect(altArrowMove(b, f('a', 'main'), 'up')).toBeNull()
    expect(altArrowMove(b, f('d', 'main'), 'down')).toBeNull()
  })

  it('moves a field to the next section (start) and the previous one (end), skipping twins', () => {
    const b = bundle()
    const r = altArrowMove(b, f('b', 'main'), 'right')
    expect(r?.next).toEqual(f('b', 't1'))
    expect(order(applyLayoutOps(b, r?.ops ?? []), 't1')).toEqual(['b', 'e'])
    // a is already in t2, so from t1 → right skips t2 and lands in Ungrouped
    const b2 = applyLayoutOps(b, [
      { op: 'move', from: { field: 'a', group_key: 'main' }, to_group_key: 't1', index: 0 }
    ])
    const skip = altArrowMove(b2, f('a', 't1'), 'right')
    expect(skip?.next).toEqual(f('a', null))
    const l = altArrowMove(b, f('u', null), 'left')
    expect(l?.next).toEqual(f('u', 't2'))
    expect(order(applyLayoutOps(b, l?.ops ?? []), 't2')).toEqual(['f', 'a', 'u'])
    expect(altArrowMove(b, f('a', 'main'), 'left')).toBeNull()
  })

  it('moves sections in the page order and tabs sideways', () => {
    const b = bundle()
    const m = altArrowMove(b, { kind: 'group', key: 'main' }, 'down')
    const after = applyLayoutOps(b, m?.ops ?? [])
    expect(after.groups.find((g) => g.key === 'tabs')?.sort).toBe(0)
    expect(after.groups.find((g) => g.key === 'main')?.sort).toBe(1)
    expect(altArrowMove(b, { kind: 'group', key: 'main' }, 'right')).toBeNull()
    const t = altArrowMove(b, { kind: 'group', key: 't2' }, 'left')
    expect(t?.label).toBe('Move tab "Shipping" left')
    const tabs = applyLayoutOps(b, t?.ops ?? [])
    expect(tabs.groups.find((g) => g.key === 't2')?.sort).toBe(0)
  })
})

describe('auto-arrange', () => {
  it('simulates the grid rows and their gaps', () => {
    expect(gridRows([6, 4, 6, 4])).toEqual([
      [0, 1],
      [2, 3]
    ])
    expect(gapCount([6, 4, 6, 4])).toBe(2)
    expect(gapCount([6, 6, 12])).toBe(0)
  })

  it('packs a later field into a hole, looking only a few fields ahead', () => {
    expect(packRows([6, 4, 6, 4, 2])).toEqual([
      [0, 2],
      [1, 3, 4]
    ])
    expect(packRows([6, 12, 12, 12, 6])).toEqual([[0], [1], [2], [3], [4]])
    expect(packRows([6, 12, 12, 12, 6], 4)).toEqual([[0, 4], [1], [2], [3]])
  })

  it('widens a row only as much as it needs, evenly', () => {
    expect(fillRow([6])).toEqual([12])
    expect(fillRow([6, 4])).toEqual([6, 6])
    expect(fillRow([4, 3, 3])).toEqual([4, 4, 4])
    expect(fillRow([6, 6])).toBeNull()
  })

  it('plans one undoable batch that leaves no gaps', () => {
    const b = bundle()
    const plan = planAutoArrange(b, { zone: 'main' })
    const after = applyLayoutOps(b, plan.ops)
    expect(order(after, 'main')).toEqual(['a', 'c', 'b', 'd'])
    expect(zoneItems(after, 'main').map((p) => p.col_span)).toEqual([6, 6, 6, 6])
    expect(plan.zones).toHaveLength(1)
    expect(plan.zones[0]).toMatchObject({ gapsBefore: 2, gapsAfter: 0, rowsAfter: 2 })
    expect(planAutoArrange(after, { zone: 'main' }).ops).toEqual([])
  })

  it('without widening only reorders; hidden fields ride along after their neighbour', () => {
    const b = bundle()
    b.placements.push(place('h', 'main', 1.5, { overrides: { hidden: true }, col_span: 12 }))
    const plan = planAutoArrange(applyLayoutOps(b, []), { zone: 'main', widen: false })
    const after = applyLayoutOps(applyLayoutOps(b, []), plan.ops)
    expect(order(after, 'main')).toEqual(['a', 'c', 'b', 'h', 'd'])
    expect(plan.ops.every((o) => o.op === 'move')).toBe(true)
  })

  it('the whole form: every zone, full rows untouched', () => {
    const plan = planAutoArrange(bundle())
    expect(plan.checked).toBe(4)
    expect(plan.zones.map((z) => z.key)).toEqual(['main'])
  })
})
