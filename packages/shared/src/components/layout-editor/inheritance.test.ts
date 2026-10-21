import { describe, expect, it } from 'vitest'
import {
  applyLayoutOps,
  type GroupRow,
  type LayoutBundle,
  newGroup,
  newPlacement,
  type PlacementRow
} from '../../lib/layout-ops'
import { overriddenTargets, resetGroupPlan, resetPlacementOps } from './inheritance'

const bundle = (
  id: number,
  name: string,
  groups: GroupRow[],
  placements: PlacementRow[]
): LayoutBundle => ({
  layout: { id, collection: 'po', name },
  groups,
  placements,
  rev: '1'
})
const place = (field: string, group: string | null, sort = 0) => ({
  ...newPlacement(field, group),
  sort
})

const parent = bundle(
  1,
  'Base order',
  [newGroup('main', 'Main', 'section', null), newGroup('money', 'Money', 'section', null)],
  [place('title', 'main'), place('vendor', 'main', 1), place('total', 'money')]
)

describe('overriddenTargets', () => {
  it('names child nodes the parent also has', () => {
    const child = bundle(
      2,
      'Rush order',
      [newGroup('money', 'Cost', 'section', null), newGroup('rush', 'Rush', 'section', null)],
      [place('total', 'money'), place('rush_reason', 'rush')]
    )
    const m = overriddenTargets(child, parent)
    expect([...m.keys()].sort()).toEqual(['field:total:money', 'group:money'])
    expect(m.get('group:money')).toBe('Base order')
  })
})

describe('reset to parent', () => {
  it('a field: every child placement of it goes', () => {
    const child = bundle(
      2,
      'Rush',
      [newGroup('money', 'Cost', 'section', null)],
      [place('total', 'money'), place('total', null)]
    )
    const ops = resetPlacementOps(child, 'total')
    expect(ops).toHaveLength(2)
    expect(applyLayoutOps(child, ops).placements).toEqual([])
  })

  it('a section: fields the parent places reset, the others move to Ungrouped', () => {
    const child = bundle(
      2,
      'Rush',
      [newGroup('money', 'Cost', 'section', null)],
      [place('total', 'money'), place('rush_fee', 'money', 1)]
    )
    const plan = resetGroupPlan(child, parent, 'money')
    if (!plan.ok) throw new Error(plan.why)
    expect(plan.reset).toEqual(['total'])
    expect(plan.ungrouped).toEqual(['rush_fee'])
    const after = applyLayoutOps(child, plan.ops)
    expect(after.groups.some((g) => g.key === 'money')).toBe(false)
    expect(after.placements.map((p) => [p.field, p.group_key])).toEqual([['rush_fee', null]])
  })

  it('refuses a tabs holder whose tabs the child keeps, and own sections', () => {
    const p = bundle(1, 'Base', [newGroup('box', 'Box', 'container', null)], [])
    const child = bundle(
      2,
      'Rush',
      [newGroup('box', 'Box', 'container', null), newGroup('t1', 'One', 'tab', 'box')],
      []
    )
    expect(resetGroupPlan(child, p, 'box')).toEqual({
      ok: false,
      why: 'Reset its tab to the parent first'
    })
    expect(resetGroupPlan(child, p, 't1').ok).toBe(false)
  })
})
