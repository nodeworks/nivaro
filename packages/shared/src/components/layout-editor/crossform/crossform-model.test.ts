import { describe, expect, it } from 'vitest'
import {
  applyLayoutOps,
  type GroupRow,
  type LayoutBundle,
  newGroup,
  newPlacement,
  type PlacementRow
} from '../../../lib/layout-ops'
import {
  compareCounts,
  compareLayouts,
  compareMarksFor,
  linkParentOps,
  placementLabel,
  unifyLabelOps
} from './crossform-model'

const place = (field: string, group: string | null, extra: Partial<PlacementRow> = {}) => ({
  ...newPlacement(field, group),
  ...extra
})

function bundle(
  id: number,
  placements: PlacementRow[],
  groups: GroupRow[] = [newGroup('main', 'Main', 'section', null)],
  layout: Record<string, unknown> = {}
): LayoutBundle {
  return {
    layout: { id, collection: 'orders', layout_type: 'grouped', ...layout },
    groups,
    placements,
    rev: 'r1'
  }
}

const labels = new Map([
  ['vendor', 'Vendor'],
  ['amount', 'Amount'],
  ['site', 'Site']
])

describe('labels', () => {
  it('reads the label a placement shows', () => {
    expect(placementLabel(place('vendor', 'main'), 'Vendor')).toBe('Vendor')
    expect(placementLabel(place('vendor', 'main', { label_override: 'Seller' }), 'Vendor')).toBe(
      'Seller'
    )
    expect(
      placementLabel(place('vendor', 'main', { overrides: { label: 'Supplier' } }), 'Vendor')
    ).toBe('Supplier')
    expect(placementLabel(place('vendor', 'main', { overrides: { label: '' } }), 'Vendor')).toBe(
      null
    )
  })

  it('unifies to another label, keeping other overrides', () => {
    const b = bundle(1, [
      place('vendor', 'main', { label_override: 'Seller', overrides: { readonly: true } })
    ])
    const ops = unifyLabelOps(b, 'vendor', 'Supplier', 'Vendor')
    expect(ops).toEqual([
      {
        op: 'update_placement',
        at: { field: 'vendor', group_key: 'main' },
        patch: { label_override: null, overrides: { readonly: true, label: 'Supplier' } }
      }
    ])
    const after = applyLayoutOps(b, ops)
    expect(placementLabel(after.placements[0], 'Vendor')).toBe('Supplier')
    expect(unifyLabelOps(after, 'vendor', 'Supplier', 'Vendor')).toEqual([])
  })

  it("clears the override for the field's own label and leaves hidden labels alone", () => {
    const b = bundle(1, [
      place('vendor', 'main', { overrides: { label: 'Supplier' } }),
      place('amount', 'main', { overrides: { label: '' } })
    ])
    expect(unifyLabelOps(b, 'vendor', 'Vendor', 'Vendor')[0]).toMatchObject({
      patch: { label_override: null, overrides: null }
    })
    expect(unifyLabelOps(b, 'amount', 'Total', 'Amount')).toEqual([])
    expect(unifyLabelOps(b, 'site', 'Place', 'Site')).toEqual([])
  })

  it('links a parent only when the layout has none', () => {
    expect(linkParentOps(bundle(2, []), 1)).toEqual([
      { op: 'layout_update', patch: { parent_layout_id: 1 } }
    ])
    expect(linkParentOps(bundle(2, [], [], { parent_layout_id: 5 }), 1)).toEqual([])
  })
})

describe('compareLayouts', () => {
  const a = {
    bundle: bundle(1, [
      place('vendor', 'main'),
      place('amount', 'main', { col_span: 6 }),
      place('site', 'main'),
      place('__pipeline__', null)
    ]),
    parent: null
  }
  const b = {
    bundle: bundle(
      2,
      [
        place('vendor', 'main', { overrides: { label: 'Supplier' } }),
        place('amount', 'extra'),
        place('notes', 'extra')
      ],
      [newGroup('main', 'Main', 'section', null), newGroup('extra', 'Extra', 'section', null)]
    ),
    parent: null
  }

  it('sorts differences first and says what differs', () => {
    const out = compareLayouts(a, b, labels)
    expect(out.map((e) => [e.field, e.status])).toEqual([
      ['amount', 'differs'],
      ['vendor', 'differs'],
      ['__pipeline__', 'only_a'],
      ['site', 'only_a'],
      ['notes', 'only_b']
    ])
    expect(out[0].diffs).toEqual(['Section: Main → Extra', 'Width: ½ → Full'])
    expect(out[1].diffs).toEqual(['Label: “Vendor” → “Supplier”'])
    expect(out[2].label).toBe('Pipeline')
    expect(compareCounts(out)).toEqual({ same: 0, only_a: 2, only_b: 1, differs: 2 })
  })

  it("counts a parent's fields the child does not place", () => {
    const child = { bundle: bundle(3, [place('vendor', 'main')]), parent: a.bundle }
    const out = compareLayouts(a, child, labels)
    expect(compareCounts(out)).toEqual({ same: 4, only_a: 0, only_b: 0, differs: 0 })
  })

  it('tags each pane', () => {
    const out = compareLayouts(a, b, labels)
    const marksA = compareMarksFor('a', out, a, b)
    const marksB = compareMarksFor('b', out, b, a)
    expect(marksA({ kind: 'field', field: 'site', group_key: 'main' })[0].text).toBe('Only here')
    expect(marksB({ kind: 'field', field: 'site', group_key: 'main' })).toEqual([])
    expect(marksB({ kind: 'field', field: 'amount', group_key: 'extra' })[0]).toMatchObject({
      text: 'Differs',
      tip: 'Section: Main → Extra · Width: ½ → Full'
    })
    expect(marksB({ kind: 'group', key: 'extra' })[0].text).toBe('Only here')
    expect(marksB({ kind: 'group', key: 'main' })).toEqual([])
  })
})
