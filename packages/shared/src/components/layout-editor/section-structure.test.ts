import { describe, expect, it } from 'vitest'
import { isFolded, readGroupStructure } from '../../lib/form-structure'
import {
  applyLayoutOps,
  type GroupRow,
  type LayoutBundle,
  newGroup,
  newPlacement,
  type PlacementRow
} from '../../lib/layout-ops'
import { zoneItems } from './field-zones'
import {
  foldPlan,
  joinBlocked,
  joinPlan,
  rowPlan,
  rowUpdatePlan,
  splitBlocked,
  splitPlan,
  stickyPlan
} from './section-structure'
import type { StructurePlan } from './structure-ops'
import { inverseOps } from './useLayoutDraft'

// #2696 split / join, #2697 rows, #2698 fold, #2699 sticky.

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
const grp = (
  key: string,
  label: string,
  type: string,
  parent: string | null,
  sort: number,
  over: Partial<GroupRow> = {}
): GroupRow => ({ ...newGroup(key, label, type, parent), sort, ...over })

function bundle(): LayoutBundle {
  return {
    layout: { id: 1, collection: 'orders', name: 'Form', layout_type: 'grouped' },
    groups: [
      grp('ship', 'Shipping', 'section', null, 0, {
        hidden_for_roles: '["r1"]',
        content: 'Where it goes',
        swap_config: JSON.stringify({
          sticky: true,
          row_groups: [{ key: 'row', label: 'Address', fields: ['street', 'city'] }]
        })
      }),
      grp('bill', 'Billing', 'section', null, 1, {
        is_collapsed: true,
        swap_config: JSON.stringify({
          row_groups: [{ key: 'row', label: 'Qty', fields: ['qty', 'unit'] }]
        })
      }),
      grp('tabs', 'Tabs', 'container', null, 2, { tab_mode: 'tabs' }),
      grp('t1', 'One', 'tab', 'tabs', 0),
      grp('t2', 'Two', 'tab', 'tabs', 1)
    ],
    placements: [
      place('name', 'ship', 0),
      place('street', 'ship', 1),
      place('notes', 'ship', 2),
      place('city', 'ship', 3),
      place('zip', 'ship', 4, { overrides: { fold: true } }),
      place('qty', 'bill', 0),
      place('unit', 'bill', 1),
      place('name', 'bill', 2),
      place('a', 't1', 0),
      place('b', 't2', 0)
    ],
    rev: 'r1'
  }
}

const ok = (p: StructurePlan) => {
  if (!p.ok) throw new Error(p.reason)
  return p
}
const fieldsOf = (b: LayoutBundle, key: string) => zoneItems(b, key).map((p) => p.field)
const groupOf = (b: LayoutBundle, key: string) => b.groups.find((g) => g.key === key) as GroupRow

describe('split (#2696)', () => {
  it('moves the field and everything after it to a new section below', () => {
    const b = bundle()
    const plan = ok(splitPlan(b, { kind: 'field', field: 'notes', group_key: 'ship' }))
    const after = applyLayoutOps(b, plan.ops)
    // The row (street + city) renders at street, above the cut: it stays whole.
    expect(fieldsOf(after, 'ship')).toEqual(['name', 'street', 'city'])
    expect(fieldsOf(after, 'ship_2')).toEqual(['notes', 'zip'])
    const top = after.groups.filter((g) => g.parent_key === null).sort((x, y) => x.sort - y.sort)
    expect(top.map((g) => g.key)).toEqual(['ship', 'ship_2', 'bill', 'tabs'])
    const made = groupOf(after, 'ship_2')
    expect(made.label).toBe('Shipping (continued)')
    expect(made.hidden_for_roles).toBe('["r1"]')
    expect(made.content).toBe(null)
    expect(readGroupStructure(made.swap_config)).toEqual({
      sticky: false,
      emptyText: null,
      rows: []
    })
    expect(readGroupStructure(groupOf(after, 'ship').swap_config).sticky).toBe(true)
    // One undo step puts it all back.
    const undone = applyLayoutOps(after, inverseOps(b, plan.ops))
    expect(fieldsOf(undone, 'ship')).toEqual(fieldsOf(b, 'ship'))
    expect(undone.groups.some((g) => g.key === 'ship_2')).toBe(false)
  })

  it('takes a row along when the cut is at its first member', () => {
    const b = bundle()
    const after = applyLayoutOps(
      b,
      ok(splitPlan(b, { kind: 'field', field: 'street', group_key: 'ship' })).ops
    )
    expect(fieldsOf(after, 'ship')).toEqual(['name'])
    expect(fieldsOf(after, 'ship_2')).toEqual(['street', 'notes', 'city', 'zip'])
    expect(readGroupStructure(groupOf(after, 'ship_2').swap_config).rows[0].fields).toEqual([
      'street',
      'city'
    ])
    expect(readGroupStructure(groupOf(after, 'ship').swap_config).rows).toEqual([])
  })

  it('refuses inside a row, at the first field and outside sections', () => {
    const b = bundle()
    expect(splitBlocked(b, { kind: 'field', field: 'city', group_key: 'ship' })).toMatch(/row/)
    expect(splitBlocked(b, { kind: 'field', field: 'name', group_key: 'ship' })).toMatch(/first/)
    expect(splitBlocked(b, { kind: 'group', key: 'ship' })).toMatch(/Select the field/)
    expect(splitBlocked(b, { kind: 'field', field: 'x', group_key: null })).toMatch(/Ungrouped/)
  })
})

describe('join (#2696)', () => {
  it('appends the next section, keeps the first one’s settings, shows a twin once', () => {
    const b = bundle()
    const plan = ok(joinPlan(b, 'ship'))
    const after = applyLayoutOps(b, plan.ops)
    expect(fieldsOf(after, 'ship')).toEqual([
      'name',
      'street',
      'notes',
      'city',
      'zip',
      'qty',
      'unit'
    ])
    expect(after.groups.some((g) => g.key === 'bill')).toBe(false)
    expect(groupOf(after, 'ship').is_collapsed).toBe(false)
    const rows = readGroupStructure(groupOf(after, 'ship').swap_config).rows
    expect(rows.map((r) => r.key)).toEqual(['row', 'row_bill'])
    expect(plan.notes.join(' ')).toMatch(/1 field in both shows once/)
    const undone = applyLayoutOps(after, inverseOps(b, plan.ops))
    expect(fieldsOf(undone, 'bill')).toEqual(['qty', 'unit', 'name'])
  })

  it('joins tabs of one holder, never across a holder or a container', () => {
    const b = bundle()
    expect(fieldsOf(applyLayoutOps(b, ok(joinPlan(b, 't1')).ops), 't1')).toEqual(['a', 'b'])
    expect(joinBlocked(b, 't2')).toMatch(/No tab/)
    expect(joinBlocked(b, 'bill')).toMatch(/No section/)
    expect(joinBlocked(b, 'tabs')).toMatch(/Only sections/)
  })
})

describe('rows (#2697)', () => {
  it('puts fields side by side, moved together under a default label', () => {
    const b = bundle()
    const sel = [
      { kind: 'field' as const, field: 'zip', group_key: 'ship' },
      { kind: 'field' as const, field: 'name', group_key: 'ship' }
    ]
    const plan = ok(rowPlan(b, sel, (x) => x.toUpperCase()))
    const after = applyLayoutOps(b, plan.ops)
    expect(fieldsOf(after, 'ship')).toEqual(['name', 'zip', 'street', 'notes', 'city'])
    const rows = readGroupStructure(groupOf(after, 'ship').swap_config).rows
    expect(rows.find((r) => r.key === 'row_2')).toEqual({
      key: 'row_2',
      label: 'NAME / ZIP',
      fields: ['name', 'zip']
    })
    // The fold lets go of a field that joins a row.
    expect(isFolded(after.placements.find((p) => p.field === 'zip')?.overrides)).toBe(false)
  })

  it('takes a field out of its old row, dropping a row left with one', () => {
    const b = bundle()
    const after = applyLayoutOps(
      b,
      ok(
        rowPlan(b, [
          { kind: 'field', field: 'city', group_key: 'ship' },
          { kind: 'field', field: 'notes', group_key: 'ship' }
        ])
      ).ops
    )
    expect(
      readGroupStructure(groupOf(after, 'ship').swap_config).rows.map((r) => r.fields)
    ).toEqual([['notes', 'city']])
  })

  it('edits and takes a row apart', () => {
    const b = bundle()
    let after = applyLayoutOps(b, ok(rowUpdatePlan(b, 'ship', 'row', { label: 'Where' })).ops)
    expect(readGroupStructure(groupOf(after, 'ship').swap_config).rows[0].label).toBe('Where')
    after = applyLayoutOps(b, ok(rowUpdatePlan(b, 'ship', 'row', null)).ops)
    expect(readGroupStructure(groupOf(after, 'ship').swap_config).rows).toEqual([])
    expect(readGroupStructure(groupOf(after, 'ship').swap_config).sticky).toBe(true)
  })

  it('refuses one field, mixed sections and ungrouped fields', () => {
    const b = bundle()
    expect(rowPlan(b, [{ kind: 'field', field: 'name', group_key: 'ship' }]).ok).toBe(false)
    const mixed = rowPlan(b, [
      { kind: 'field', field: 'name', group_key: 'ship' },
      { kind: 'field', field: 'qty', group_key: 'bill' }
    ])
    expect(!mixed.ok && mixed.reason).toMatch(/one section/)
  })
})

describe('fold (#2698) and sticky (#2699)', () => {
  it('folds fields but never row members', () => {
    const b = bundle()
    const rows = b.placements.filter((p) => p.group_key === 'ship')
    const plan = ok(foldPlan(b, rows, true))
    const after = applyLayoutOps(b, plan.ops)
    const folded = after.placements.filter((p) => p.group_key === 'ship' && isFolded(p.overrides))
    expect(folded.map((p) => p.field).sort()).toEqual(['name', 'notes', 'zip'])
    expect(plan.notes[0]).toMatch(/2 fields in a row stay out/)
    const off = ok(foldPlan(after, folded, false))
    expect(off.ops).toHaveLength(3)
  })

  it('keeps one sticky section per form', () => {
    const b = bundle()
    const plan = ok(stickyPlan(b, 'bill', true))
    const after = applyLayoutOps(b, plan.ops)
    expect(readGroupStructure(groupOf(after, 'bill').swap_config).sticky).toBe(true)
    expect(readGroupStructure(groupOf(after, 'ship').swap_config).sticky).toBe(false)
    // The rows of the section that stopped sticking survive.
    expect(readGroupStructure(groupOf(after, 'ship').swap_config).rows).toHaveLength(1)
    expect(plan.notes[0]).toMatch(/Shipping stops sticking/)
    expect(stickyPlan(b, 't1', true).ok).toBe(false)
  })
})
