import { describe, expect, it } from 'vitest'
import {
  type BulkAction,
  type MacroStep,
  pageOrder,
  parseBulkAction,
  parseMacroSteps,
  planForm
} from '../../../services/layout-bulk-plan.js'
import {
  applyLayoutOps,
  type GroupRow,
  type LayoutBundle,
  newGroup,
  newPlacement,
  type PlacementRow
} from '../../../services/layout-ops-apply.js'

const L = (f: string) => f

function group(key: string, label: string, sort: number, extra: Partial<GroupRow> = {}): GroupRow {
  return { ...newGroup(key, label, 'section', null), sort, ...extra }
}
function place(field: string, gk: string | null, sort: number, extra: Partial<PlacementRow> = {}) {
  return { ...newPlacement(field, gk), sort, ...extra }
}
function bundle(
  groups: GroupRow[],
  placements: PlacementRow[],
  layout: Record<string, unknown> = {}
): LayoutBundle {
  return {
    layout: { id: 1, collection: 'po', name: 'Form', layout_type: 'grouped', ...layout },
    groups,
    placements,
    rev: 'r1'
  }
}

const fieldsOf = (b: LayoutBundle, gk: string | null) =>
  b.placements
    .filter((p) => p.group_key === gk)
    .sort((x, y) => x.sort - y.sort)
    .map((p) => p.field)

const run = (b: LayoutBundle, action: BulkAction) => {
  const plan = planForm(b, action, L)
  return { plan, after: plan.ops.length ? applyLayoutOps(b, plan.ops) : b }
}

describe('parseBulkAction', () => {
  it('refuses a missing field, a slot name and a self anchor', () => {
    expect(parseBulkAction({ kind: 'retire' })).toHaveProperty('error')
    expect(parseBulkAction({ kind: 'retire', field: '__pipeline__' })).toHaveProperty('error')
    expect(
      parseBulkAction({
        kind: 'change',
        change: { type: 'place_after', field: 'a', anchor: 'a' }
      })
    ).toHaveProperty('error')
    expect(
      parseBulkAction({ kind: 'change', change: { type: 'set_width', field: 'a', width: 5 } })
    ).toHaveProperty('error')
  })

  it('accepts the five changes', () => {
    for (const change of [
      { type: 'place_before', field: 'a', anchor: 'b' },
      { type: 'set_width', field: 'a', width: 6 },
      { type: 'set_flag', field: 'a', flag: 'readonly', on: true },
      { type: 'remove', field: 'a' }
    ])
      expect(parseBulkAction({ kind: 'change', change })).toHaveProperty('action')
  })
})

describe('one change on every form (#2662)', () => {
  const base = bundle(
    [group('main', 'Main', 0), group('money', 'Money', 1)],
    [
      place('po_number', 'main', 0),
      place('vendor', 'main', 1),
      place('amount', 'money', 0),
      place('fusion_number', 'money', 1)
    ]
  )

  it('moves the field after the anchor, across sections', () => {
    const { plan, after } = run(base, {
      kind: 'change',
      change: { type: 'place_after', field: 'fusion_number', anchor: 'po_number' }
    })
    expect(plan.status).toBe('change')
    expect(plan.changes[0]).toContain('from "Money"')
    expect(fieldsOf(after, 'main')).toEqual(['po_number', 'fusion_number', 'vendor'])
    expect(fieldsOf(after, 'money')).toEqual(['amount'])
  })

  it('places a field the form does not hold yet, before the anchor', () => {
    const { plan, after } = run(base, {
      kind: 'change',
      change: { type: 'place_before', field: 'notes', anchor: 'vendor' }
    })
    expect(plan.changes[0]).toMatch(/^Adds notes before vendor/)
    expect(fieldsOf(after, 'main')).toEqual(['po_number', 'notes', 'vendor'])
  })

  it('skips a form without the anchor and says so', () => {
    const plan = planForm(
      base,
      { kind: 'change', change: { type: 'place_after', field: 'amount', anchor: 'missing' } },
      L
    )
    expect(plan).toMatchObject({ status: 'skip', reason: 'missing is not on this form', ops: [] })
  })

  it('reports nothing to do when the field already sits there', () => {
    const plan = planForm(
      base,
      { kind: 'change', change: { type: 'place_after', field: 'vendor', anchor: 'po_number' } },
      L
    )
    expect(plan.status).toBe('same')
  })

  it('sets width, flags and removes', () => {
    const width = run(base, {
      kind: 'change',
      change: { type: 'set_width', field: 'amount', width: 6 }
    })
    expect(width.after.placements.find((p) => p.field === 'amount')?.col_span).toBe(6)
    const req = run(base, {
      kind: 'change',
      change: { type: 'set_flag', field: 'vendor', flag: 'required', on: true }
    })
    expect(req.after.placements.find((p) => p.field === 'vendor')?.overrides).toEqual({
      required: true
    })
    const off = planForm(
      req.after,
      {
        kind: 'change',
        change: { type: 'set_flag', field: 'vendor', flag: 'required', on: false }
      },
      L
    )
    expect(off.ops[0]).toMatchObject({ patch: { overrides: null } })
    const gone = run(base, { kind: 'change', change: { type: 'remove', field: 'vendor' } })
    expect(fieldsOf(gone.after, 'main')).toEqual(['po_number'])
    const absent = planForm(
      base,
      { kind: 'change', change: { type: 'set_width', field: 'nope', width: 6 } },
      L
    )
    expect(absent).toMatchObject({ status: 'same', reason: 'nope is not on this form' })
  })
})

describe('retire a field (#2639)', () => {
  it('removes every placement and the settings that name it, and warns about rules', () => {
    const b = bundle(
      [
        group('main', 'Main', 0, {
          summary_fields: JSON.stringify(['vendor', { field: 'old', label: 'Old' }]),
          visible_when: JSON.stringify([{ field: 'old', op: '_nnull' }])
        })
      ],
      [place('old', 'main', 0), place('vendor', 'main', 1), place('old', '__header__', 0)],
      {
        header_fields: ['old'],
        quick_picker: ['vendor', 'old'],
        default_values: { old: 1, vendor: 2 },
        record_conditions: [{ field: 'old', op: '_eq', value: 1 }]
      }
    )
    const { plan, after } = run(b, { kind: 'retire', field: 'old' })
    expect(plan.status).toBe('change')
    expect(after.placements.map((p) => p.field)).toEqual(['vendor'])
    expect(after.groups.find((g) => g.key === 'main')?.summary_fields).toBe('["vendor"]')
    expect(after.layout).toMatchObject({
      header_fields: null,
      quick_picker: ['vendor'],
      default_values: { vendor: 2 }
    })
    expect(plan.notes).toHaveLength(2)
  })

  it('has nothing to do on a form without it', () => {
    const plan = planForm(bundle([], [place('a', null, 0)]), { kind: 'retire', field: 'old' }, L)
    expect(plan.status).toBe('same')
  })
})

describe('macro replay (#2663)', () => {
  const steps: MacroStep[] = [
    {
      op: 'group_create',
      group: { key: 'g_rec', label: 'Fusion' },
      group_type: 'section',
      parent: null,
      after: { key: 'g_x', label: 'Main' }
    },
    {
      op: 'move',
      field: 'fusion_number',
      from: { key: 'g_y', label: 'Money' },
      to: { key: 'g_rec', label: 'Fusion' },
      after: null
    },
    {
      op: 'update_placement',
      field: 'vendor',
      group: { key: 'zz', label: 'main' },
      patch: { col_span: 6 }
    },
    { op: 'remove', field: 'missing_field', group: null },
    { op: 'layout_update', patch: { name: 'Renamed' } }
  ]

  it('maps sections by label, keeps going past steps that do not apply', () => {
    const b = bundle(
      [group('k1', 'Main', 0), group('k2', 'Money', 1)],
      [place('vendor', 'k1', 0), place('fusion_number', 'k2', 0)]
    )
    const plan = planForm(b, { kind: 'macro', name: 'm', steps }, L)
    expect(plan.status).toBe('change')
    const after = applyLayoutOps(b, plan.ops)
    // New section right after Main, holding the moved field.
    const top = after.groups.filter((g) => g.parent_key === null).map((g) => g.label)
    expect(top.slice(0, 2)).toEqual(['Main', 'Fusion'])
    expect(fieldsOf(after, 'g_rec')).toEqual(['fusion_number'])
    expect(after.placements.find((p) => p.field === 'vendor')?.col_span).toBe(6)
    expect(after.layout.name).toBe('Form')
    expect(plan.notes).toEqual([
      'Step 4 skipped: missing_field is not in Ungrouped',
      'Step 5 skipped: form name, order and type are never replayed'
    ])
  })

  it('reuses a section of the same label instead of adding a second one', () => {
    const b = bundle(
      [group('k1', 'Main', 0), group('f', 'fusion', 1), group('k2', 'Money', 2)],
      [place('vendor', 'k1', 0), place('fusion_number', 'k2', 0)]
    )
    const plan = planForm(b, { kind: 'macro', name: 'm', steps: steps.slice(0, 2) }, L)
    const after = applyLayoutOps(b, plan.ops)
    expect(after.groups.filter((g) => g.label.toLowerCase() === 'fusion')).toHaveLength(1)
    expect(fieldsOf(after, 'f')).toEqual(['fusion_number'])
    expect(plan.notes[0]).toContain('already on this form')
  })

  it('skips a form where no step applies', () => {
    const plan = planForm(bundle([], []), { kind: 'macro', name: 'm', steps: [steps[3]] }, L)
    expect(plan.status).toBe('skip')
  })

  it('refuses malformed steps', () => {
    expect(parseMacroSteps([])).toHaveProperty('error')
    expect(parseMacroSteps([{ op: 'drop_table' }])).toHaveProperty('error')
    expect(parseMacroSteps([{ op: 'remove', field: 'a', group: null }])).toHaveProperty('steps')
  })
})

describe('pageOrder', () => {
  it('reads header, then sections in order with Ungrouped in its place', () => {
    const b = applyLayoutOps(
      bundle(
        [
          group('a', 'A', 0),
          group('b', 'B', 2),
          { ...newGroup('__ungrouped__', 'U', 'ungrouped', null), sort: 1 }
        ],
        [place('x', 'b', 0), place('y', null, 0), place('z', 'a', 0), place('h', '__header__', 0)]
      ),
      []
    )
    expect(pageOrder(b).map((p) => p.field)).toEqual(['h', 'z', 'y', 'x'])
  })
})
