import { describe, expect, it } from 'vitest'
import { withGroupStructure } from '../../lib/form-structure'
import {
  applyLayoutOps,
  type GroupRow,
  type LayoutBundle,
  newGroup,
  newPlacement,
  type PlacementRow,
  ungroupedGroup
} from '../../lib/layout-ops'
import type { DesignTarget } from './design-context'
import { evenRowBlocked, evenRowPlan, evenWidth, rowOfPlacement } from './even-row'

// #3180 Even out a row.

const place = (
  field: string,
  group: string | null,
  sort: number,
  span: number | null,
  over: Partial<PlacementRow> = {}
) => ({
  ...newPlacement(field, group),
  sort,
  col_span: span,
  ...over
})
const grp = (key: string, sort: number, over: Partial<GroupRow> = {}): GroupRow => ({
  ...newGroup(key, key, 'section', null),
  sort,
  ...over
})

// main: [a ½, b ¼] [c ⅓, d ⅓, e ¼] [f full]; hidden h between a and b takes no room.
function bundle(): LayoutBundle {
  return {
    layout: { id: 1, collection: 'orders', name: 'Form', layout_type: 'grouped' },
    groups: [grp('main', 0), ungroupedGroup(1)],
    placements: [
      place('a', 'main', 0, 6),
      place('h', 'main', 1, 6, { overrides: { hidden: true } }),
      place('b', 'main', 2, 3),
      place('c', 'main', 3, 4),
      place('d', 'main', 4, 4),
      place('e', 'main', 5, 3),
      place('f', 'main', 6, null)
    ],
    rev: 'r0'
  }
}

const field = (f: string, g: string | null = 'main'): DesignTarget => ({
  kind: 'field',
  field: f,
  group_key: g
})
const spans = (b: LayoutBundle) =>
  Object.fromEntries(b.placements.map((p) => [p.field, p.col_span ?? 12]))

describe('even out a row (#3180)', () => {
  it('even widths: 1 → full, 2 → ½, 3 → ⅓, 4 → ¼', () => {
    expect([1, 2, 3, 4, 5].map(evenWidth)).toEqual([12, 6, 4, 3, null])
  })

  it('finds the grid row; hidden fields take no room', () => {
    const b = bundle()
    const p = b.placements.find((x) => x.field === 'b') as PlacementRow
    expect(rowOfPlacement(b, p)?.map((x) => x.field)).toEqual(['a', 'b'])
    const h = b.placements.find((x) => x.field === 'h') as PlacementRow
    expect(rowOfPlacement(b, h)).toBeNull()
  })

  it('splits the row evenly in one step and leaves the other rows alone', () => {
    const b = bundle()
    const plan = evenRowPlan(b, [field('d')])
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.label).toBe('Even out a row: 3 fields at ⅓')
    // c and d are already ⅓: only e changes.
    expect(plan.ops).toEqual([
      { op: 'update_placement', at: { field: 'e', group_key: 'main' }, patch: { col_span: 4 } }
    ])
    const after = spans(applyLayoutOps(b, plan.ops))
    expect(after).toMatchObject({ a: 6, b: 3, c: 4, d: 4, e: 4, f: 12 })
  })

  it('a multi-selection evens every row it touches', () => {
    const plan = evenRowPlan(bundle(), [field('a'), field('c'), field('d')])
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.label).toBe('Even out 2 rows')
    expect(spans(applyLayoutOps(bundle(), plan.ops))).toMatchObject({ a: 6, b: 6, e: 4 })
  })

  it('refuses a field alone in its row, an even row, hidden fields and tables', () => {
    expect(evenRowBlocked(bundle(), [field('f')])).toBe('The field is alone in its row')
    const first = evenRowPlan(bundle(), [field('a')])
    if (!first.ok) throw new Error(first.reason)
    const even = applyLayoutOps(bundle(), first.ops)
    expect(evenRowBlocked(even, [field('a')])).toBe('This row is already even')
    expect(evenRowBlocked(bundle(), [field('h')])).toBe('Hidden and folded fields take no row')
    expect(evenRowBlocked(bundle(), [])).toBe('Select a field in the row first')
    const table = { ...bundle(), layout: { ...bundle().layout, layout_type: 'table' } }
    expect(evenRowBlocked(table, [field('a')])).toBe('Table columns have no rows')
  })

  it('a row group evens its members together; it is one full-width unit for the rest', () => {
    const b = bundle()
    b.groups[0] = {
      ...b.groups[0],
      swap_config: withGroupStructure(null, {
        rows: [{ key: 'r1', label: 'Where', fields: ['c', 'd', 'e'] }]
      })
    }
    const c = b.placements.find((x) => x.field === 'c') as PlacementRow
    expect(rowOfPlacement(b, c)?.map((x) => x.field)).toEqual(['c', 'd', 'e'])
    // a, b share a row; the row group sits on its own row after them.
    const a = b.placements.find((x) => x.field === 'a') as PlacementRow
    expect(rowOfPlacement(b, a)?.map((x) => x.field)).toEqual(['a', 'b'])
    const plan = evenRowPlan(b, [field('c')])
    expect(plan.ok && spans(applyLayoutOps(b, plan.ops))).toMatchObject({ c: 4, d: 4, e: 4 })
  })
})
