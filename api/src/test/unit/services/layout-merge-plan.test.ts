import { describe, expect, it } from 'vitest'
import {
  type MergeContext,
  matchGroups,
  mergeAssignment,
  planMerge,
  reachOf
} from '../../../services/layout-merge-plan.js'
import {
  applyLayoutOps,
  type GroupRow,
  type LayoutBundle,
  newGroup,
  newPlacement,
  type PlacementRow
} from '../../../services/layout-ops-apply.js'

function group(key: string, label: string, sort: number, extra: Partial<GroupRow> = {}): GroupRow {
  return { ...newGroup(key, label, 'section', null), sort, ...extra }
}
function place(field: string, gk: string | null, sort: number, extra: Partial<PlacementRow> = {}) {
  return { ...newPlacement(field, gk), sort, ...extra }
}
function bundle(
  id: number,
  name: string,
  groups: GroupRow[],
  placements: PlacementRow[],
  layout: Record<string, unknown> = {}
): LayoutBundle {
  return {
    layout: {
      id,
      collection: 'po',
      name,
      layout_type: 'grouped',
      is_active: false,
      record_conditions: null,
      conditions: null,
      slug: null,
      ...layout
    },
    groups,
    placements,
    rev: `r${id}`
  }
}

const ctx = (over: Partial<MergeContext> = {}): MergeContext => ({
  defaultId: 1,
  roles: [
    { id: 'R1', name: 'Buyer' },
    { id: 'R2', name: 'Services desk' },
    { id: 'R3', name: 'Viewer' }
  ],
  label: (f) => f.replace(/_/g, ' '),
  names: new Set(['goods form', 'services form']),
  maxSort: 4,
  ...over
})

const side = (bundle: LayoutBundle) => ({ bundle, parent: null })
const groupOf = (b: LayoutBundle, key: string) => b.groups.find((g) => g.key === key)
const fieldsIn = (b: LayoutBundle, key: string | null) =>
  b.placements
    .filter((p) => p.group_key === key)
    .sort((x, y) => x.sort - y.sort)
    .map((p) => p.field)

// The kept form: the default. The folded one opens for Type = Services.
const goods = () =>
  bundle(
    1,
    'Goods form',
    [group('details', 'Details', 0), group('shipping', 'Shipping', 1)],
    [
      place('title', 'details', 0),
      place('amount', 'details', 1),
      place('incoterm', 'details', 2),
      place('carrier', 'shipping', 0)
    ],
    { is_active: true }
  )
const services = () =>
  bundle(
    2,
    'Services form',
    [group('details', 'Details', 0), group('service', 'Service', 1)],
    [
      place('title', 'details', 0),
      place('amount', 'details', 1, { col_span: 6 }),
      place('service_code', 'details', 2),
      place('hours', 'service', 0),
      place('rate', 'service', 1)
    ],
    { record_conditions: [{ field: 'type', op: 'eq', value: 'Services' }], slug: 'services' }
  )

describe('mergeAssignment', () => {
  it('a default and a record-rule form merge into the default', () => {
    const a = reachOf(goods(), 1)
    const b = reachOf(services(), 1)
    expect(a.kind).toBe('default')
    expect(b.kind).toBe('rules')
    const { merged, notes } = mergeAssignment(a, b, { a: 'A', b: 'B' })
    expect(merged).toMatchObject({ record_conditions: null, is_active: true, role_ids: [] })
    expect(merged.slug).toBe('services')
    expect(notes[0]).toMatch(/record rules are dropped/)
  })

  it('two record-rule forms keep the rules they share', () => {
    const a = reachOf(
      bundle(1, 'A', [], [], {
        record_conditions: [
          { field: 'region', op: 'eq', value: 'East' },
          { field: 'type', op: 'eq', value: 'Goods' }
        ]
      }),
      null
    )
    const b = reachOf(
      bundle(2, 'B', [], [], {
        record_conditions: [
          { field: 'region', op: 'eq', value: 'East' },
          { field: 'type', op: 'eq', value: 'Services' }
        ]
      }),
      null
    )
    const { merged } = mergeAssignment(a, b, { a: 'A', b: 'B' })
    expect(merged.record_conditions).toEqual([{ field: 'region', op: 'eq', value: 'East' }])
  })

  it('keeps the kept form when the rules share nothing', () => {
    const a = reachOf(
      bundle(1, 'A', [], [], { record_conditions: [{ field: 't', op: 'eq', value: 'x' }] }),
      null
    )
    const b = reachOf(
      bundle(2, 'B', [], [], { record_conditions: [{ field: 'u', op: 'nnull' }] }),
      null
    )
    const { merged, notes } = mergeAssignment(a, b, { a: 'A', b: 'B' })
    expect(merged.record_conditions).toEqual([{ field: 't', op: 'eq', value: 'x' }])
    expect(notes.join(' ')).toMatch(/nothing in common/)
  })

  it('role forms merge into the union of their roles', () => {
    const a = reachOf(bundle(1, 'A', [], [], { conditions: { role_ids: ['R1'] } }), null)
    const b = reachOf(bundle(2, 'B', [], [], { conditions: { role_ids: ['r2', 'R1'] } }), null)
    expect(mergeAssignment(a, b, { a: 'A', b: 'B' }).merged.role_ids).toEqual(['R1', 'r2'])
  })
})

describe('matchGroups', () => {
  it('matches by key, else by label under the same parent', () => {
    const a = bundle(1, 'A', [group('details', 'Details', 0), group('misc', 'Other', 1)], [])
    const b = bundle(2, 'B', [group('details', 'Details', 0), group('other_x', 'other ', 1)], [])
    const view = (x: LayoutBundle) => ({
      name: 'x',
      groups: new Map(x.groups.map((g) => [g.key, g])),
      own: new Set(x.groups.map((g) => g.key)),
      placements: new Map(),
      ownPlacement: new Set<string>()
    })
    const m = matchGroups(view(a), view(b))
    expect(m.get('details')).toBe('details')
    expect(m.get('other_x')).toBe('misc')
  })
})

describe('planMerge', () => {
  it('turns the differences into section rules and carries the assignment', () => {
    const keep = goods()
    const fold = services()
    const plan = planMerge(side(keep), side(fold), ctx())
    const after = applyLayoutOps(keep, plan.keep_ops)

    // The folded form's own section comes across, shown for its records.
    const service = after.groups.find((g) => g.label === 'Service')
    expect(service).toBeTruthy()
    expect(JSON.parse(String(service?.visible_when))).toEqual([
      { field: 'type', op: 'eq', value: 'Services' }
    ])
    expect(fieldsIn(after, service?.key ?? '')).toEqual(['hours', 'rate'])

    // Its extra field in a shared section goes in a ruled section beside it.
    const split = after.groups.find((g) => g.label === 'Details (Services form)')
    expect(split).toBeTruthy()
    expect(fieldsIn(after, split?.key ?? '')).toEqual(['service_code'])
    expect(JSON.parse(String(split?.visible_when))[0]).toMatchObject({
      op: 'eq',
      value: 'Services'
    })

    // What only the kept form has: shown when the folded form's rule does not hold.
    expect(JSON.parse(String(groupOf(after, 'shipping')?.visible_when))).toEqual([
      { field: 'type', op: 'neq', value: 'Services' }
    ])
    const own = after.groups.find((g) => g.label === 'Details (Goods form)')
    expect(fieldsIn(after, own?.key ?? '')).toEqual(['incoterm'])
    expect(fieldsIn(after, 'details')).toEqual(['title', 'amount'])

    // The kept form takes the link name; the folded one gives it up and is no longer picked.
    expect(after.layout.slug).toBe('services')
    const folded = applyLayoutOps(fold, plan.fold_ops)
    expect(folded.layout).toMatchObject({
      slug: null,
      record_conditions: null,
      name: 'Services form (merged into Goods form)',
      sort: 5
    })
    expect(plan.counts.differing).toBe(1)
    expect(plan.notes.join(' ')).toMatch(/set up differently/)
    expect(plan.assignment.join(' ')).toMatch(/default form/)
  })

  it('places the folded form’s extras unruled when nothing tells the records apart', () => {
    const keep = goods()
    const fold = bundle(
      2,
      'Services form',
      [group('details', 'Details', 0)],
      [place('title', 'details', 0), place('service_code', 'details', 1)]
    )
    const plan = planMerge(side(keep), side(fold), ctx())
    const after = applyLayoutOps(keep, plan.keep_ops)
    expect(fieldsIn(after, 'details')).toEqual(['title', 'service_code', 'amount', 'incoterm'])
    expect(plan.notes.join(' ')).toMatch(/opened only by its link name/)
    expect(after.groups.every((g) => !g.visible_when)).toBe(true)
  })

  it('carries header fields only when nothing needs a rule', () => {
    const fold = (rules: unknown) =>
      bundle(
        2,
        'Services form',
        [],
        [place('title', '__header__', 0), place('po_number', '__header__', 1)],
        { record_conditions: rules }
      )
    const keep = bundle(1, 'Goods form', [], [place('title', '__header__', 0)], { is_active: true })
    const open = planMerge(side(keep), side(fold(null)), ctx())
    expect(fieldsIn(applyLayoutOps(keep, open.keep_ops), '__header__')).toEqual([
      'title',
      'po_number'
    ])
    const ruled = planMerge(side(keep), side(fold([{ field: 'type', op: 'nnull' }])), ctx())
    expect(ruled.keep_ops.some((o) => o.op === 'place')).toBe(false)
    expect(ruled.notes.join(' ')).toMatch(/header cannot take a rule/)
  })

  it('role differences become hidden-for-roles', () => {
    const keep = goods()
    const fold = bundle(
      2,
      'Services form',
      [group('service', 'Service', 0)],
      [place('hours', 'service', 0), place('title', 'service', 1)],
      { conditions: { role_ids: ['R2'] } }
    )
    const plan = planMerge(side(keep), side(fold), ctx())
    const after = applyLayoutOps(keep, plan.keep_ops)
    const service = after.groups.find((g) => g.label === 'Service')
    expect(JSON.parse(String(service?.hidden_for_roles))).toEqual(['R1', 'R3'])
    expect(fieldsIn(after, service?.key ?? '')).toEqual(['hours'])
    expect(JSON.parse(String(groupOf(after, 'shipping')?.hidden_for_roles))).toEqual(['R2'])
    const folded = applyLayoutOps(fold, plan.fold_ops)
    expect(folded.layout.conditions).toBeNull()
  })

  it('keeps tabs inside their container', () => {
    const keep = bundle(
      1,
      'A',
      [
        group('box', 'Box', 0, { type: 'container' }),
        group('t1', 'One', 0, { type: 'tab', parent_key: 'box' })
      ],
      [place('title', 't1', 0)],
      { is_active: true }
    )
    const fold = bundle(
      2,
      'B',
      [
        group('box', 'Box', 0, { type: 'container' }),
        group('t1', 'One', 0, { type: 'tab', parent_key: 'box' }),
        group('t2', 'Two', 1, { type: 'tab', parent_key: 'box' })
      ],
      [place('title', 't1', 0), place('hours', 't2', 0), place('rate', 't1', 1)],
      { record_conditions: [{ field: 'type', op: 'nnull' }] }
    )
    const plan = planMerge(side(keep), side(fold), ctx({ names: new Set() }))
    const after = applyLayoutOps(keep, plan.keep_ops)
    const two = after.groups.find((g) => g.label === 'Two')
    expect(two).toMatchObject({ type: 'tab', parent_key: 'box' })
    const split = after.groups.find((g) => g.label === 'One (B)')
    expect(split).toMatchObject({ type: 'tab', parent_key: 'box' })
    expect(fieldsIn(after, split?.key ?? '')).toEqual(['rate'])
  })

  it('leaves the kept form as it is when the folded one adds nothing', () => {
    const keep = goods()
    const fold = bundle(2, 'Copy', [group('details', 'Details', 0)], [place('title', 'details', 0)])
    const plan = planMerge(side(keep), side(fold), ctx({ names: new Set() }))
    expect(plan.keep_ops).toEqual([])
    expect(plan.fold_ops[0]).toMatchObject({ op: 'layout_update' })
  })
})
